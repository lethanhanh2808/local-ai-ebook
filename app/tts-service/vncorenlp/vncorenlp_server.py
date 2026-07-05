"""
VnCoreNLP server — long-lived FastAPI wrapper around the VnCoreNLP Vietnamese
NLP toolkit. Started as a sidecar container (`vncorenlp` in docker-compose.yml,
port 5030). Provides per-paragraph dependency parse output that the
ebook-converter uses for Vietnamese speaker attribution.

Architecture
------------
VnCoreNLP's jar is a *batch* CLI tool (only -fin / -fout / -annotators
flags). To keep a JVM warm and query it, we use py_vncorenlp — a Python
wrapper that uses pyjnius (a JPype1 fork) to embed the JVM in-process.
The Java `VnCoreNLP` class is loaded via `autoclass`, and `annotate_text()`
parses Vietnamese text and returns token-level (form, pos, ner, head, deprel)
tuples.

Trade-off: the JVM is in the Python process, so an OOM in VnCoreNLP kills
the container. We mitigate by allocating -Xmx2g and using a dedicated
container so the JVM's memory is isolated from the Next.js and worker
containers.

Endpoints
---------
GET  /healthz     → {"ready": bool, "model": "VnCoreNLP-1.2", "jvm_up": bool}
GET  /cache_stats → {"hits": int, "misses": int, "size": int}
POST /annotate    → input  {"text": str, "annotators": [str, ...]}
                    output {"sentences": [{tokens: [...], deps: [...]}, ...],
                            "cached": bool, "elapsed_ms": int}

py_vncorenlp output schema
--------------------------
`annotate_text()` returns `dict[int → list[dict]]` keyed by sentence index.
Each token dict has:
  - index      : int  — 1-based within the sentence
  - wordForm   : str
  - posTag     : str
  - nerLabel   : str
  - head       : int  — 1-based index of governor; 0 for root
  - depLabel   : str  — e.g. "sub", "dob", "nsubj"

We normalize that to a flat list of Sentence objects with a synthesized
deps list so the consumer doesn't have to know about py_vncorenlp's quirks.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("vncorenlp")

# ── Config ─────────────────────────────────────────────────────────────
# py_vncorenlp expects `save_dir` to contain BOTH the jar and the models/
# subdirectory. So save_dir = /opt/vncorenlp (parent of models/).
SAVE_DIR = Path(os.environ.get("VNCORENLP_SAVE_DIR", "/opt/vncorenlp"))
MODEL_DIR = SAVE_DIR / "models"
JAR_PATH = SAVE_DIR / "VnCoreNLP-1.2.jar"
HTTP_PORT = int(os.environ.get("VNCORENLP_HTTP_PORT", "5030"))
ANNOTATORS = os.environ.get("VNCORENLP_ANNOTATORS", "wseg,pos,ner,parse")
CACHE_SIZE = int(os.environ.get("VNCORENLP_CACHE_SIZE", "512"))
JAVA_HEAP = os.environ.get("JAVA_OPTS", "-Xmx2g")

# ── Pydantic schemas ─────────────────────────────────────────────────────
class AnnotateRequest(BaseModel):
    text: str = Field(..., description="Raw Vietnamese text. One or many paragraphs.")
    annotators: list[str] | None = Field(
        default=None,
        description="Override default annotators. Default = wseg,pos,ner,parse.",
    )


class Token(BaseModel):
    index: int
    form: str
    posTag: str | None = None
    nerLabel: str | None = None
    head: int | None = None
    depLabel: str | None = None


class Dep(BaseModel):
    """Single dependency triple: [head, dependent, deprel]."""
    head: int
    dependent: int
    deprel: str


class Sentence(BaseModel):
    tokens: list[Token]
    deps: list[Dep] = Field(default_factory=list,
                            description="[head, dependent_index, deprel] triples")


class AnnotateResponse(BaseModel):
    sentences: list[Sentence]
    cached: bool = False
    elapsed_ms: int = 0


# ── LRU cache ────────────────────────────────────────────────────────────
class LRUCache:
    """Thread-safe LRU keyed by SHA1 of (annotators + text)."""

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self._d: OrderedDict[str, list[dict]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> list[dict] | None:
        with self._lock:
            if key in self._d:
                self._d.move_to_end(key)
                self.hits += 1
                return self._d[key]
            self.misses += 1
            return None

    def put(self, key: str, value: list[dict]) -> None:
        with self._lock:
            if key in self._d:
                self._d.move_to_end(key)
            self._d[key] = value
            if len(self._d) > self.capacity:
                self._d.popitem(last=False)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "hits": self.hits,
                "misses": self.misses,
                "size": len(self._d),
                "capacity": self.capacity,
            }


_cache = LRUCache(CACHE_SIZE)


# ── Model wrapper ──────────────────────────────────────────────────────
class VnCoreNLPModel:
    """Lazy-loaded singleton around py_vncorenlp.VnCoreNLP.

    py_vncorenlp uses jnius_config to pass -Xmx to the JVM, and the JVM is
    started on the first autoclass() call. We wrap that into a one-shot
    `start()` so we can report /healthz readiness accurately.

    Important: jnius_config.add_options() / set_classpath() can only be
    called ONCE, before the JVM is up. After that they raise
    "VM is already running, can't set classpath/options". So we capture
    the configured JVM state in `_jvm_started` and never re-apply config
    after the first start. This means changing annotators post-startup
    is NOT supported — pick one set of annotators at startup.
    """

    def __init__(self) -> None:
        self._model: Any = None
        self._annotators: list[str] = []
        self._lock = threading.Lock()
        self._loaded = False
        self._jvm_started = False
        self._load_error: Exception | None = None

    @property
    def is_up(self) -> bool:
        return self._loaded and self._model is not None

    def _configure_jvm(self) -> None:
        """Set jnius_config options + classpath exactly once, before the JVM
        starts. Re-applying after startup is a hard error in pyjnius."""
        if self._jvm_started:
            return
        try:
            import jnius_config  # type: ignore
        except ImportError as e:
            self._load_error = RuntimeError(f"pyjnius (jnius_config) not installed: {e}")
            raise self._load_error

        # Verify model directory layout (py_vncorenlp checks the same).
        if not (SAVE_DIR / "models" / "wordsegmenter").exists():
            self._load_error = RuntimeError(
                f"VnCoreNLP models not found at {SAVE_DIR / 'models'} "
                f"(expected 'wordsegmenter' subdir)"
            )
            raise self._load_error
        if not JAR_PATH.exists():
            self._load_error = RuntimeError(
                f"VnCoreNLP jar not found at {JAR_PATH}"
            )
            raise self._load_error

        # Pass JVM heap via jnius_config BEFORE the JVM is started.
        jnius_config.add_options(JAVA_HEAP)
        # Set classpath BEFORE the JVM is started.
        jnius_config.set_classpath(str(JAR_PATH))
        self._jvm_started = True
        log.info("JVM configured (heap=%s, classpath=%s)", JAVA_HEAP, JAR_PATH)

    def start(self) -> None:
        if self.is_up:
            return
        if self._load_error is not None:
            raise self._load_error

        self._configure_jvm()

        # Now import py_vncorenlp — autoclass inside its constructor starts the JVM.
        try:
            import py_vncorenlp  # type: ignore
        except ImportError as e:
            self._load_error = RuntimeError(f"py_vncorenlp not installed: {e}")
            raise self._load_error

        self._annotators = [a.strip() for a in ANNOTATORS.split(",") if a.strip()]
        log.info("loading VnCoreNLP from %s with annotators %s",
                 SAVE_DIR, self._annotators)
        try:
            self._model = py_vncorenlp.VnCoreNLP(
                max_heap_size=JAVA_HEAP,
                annotators=self._annotators,
                save_dir=str(SAVE_DIR),
            )
        except Exception as e:
            self._load_error = RuntimeError(f"py_vncorenlp load failed: {e}")
            raise self._load_error
        self._loaded = True
        log.info("VnCoreNLP ready (model dir=%s)", SAVE_DIR)

    def annotate_text(self, text: str, annotators: list[str] | None = None) -> list[dict]:
        if not self.is_up:
            self.start()
        # NOTE: py_vncorenlp cannot change annotators after construction — it
        # would need to re-set the JVM classpath/options, which raises
        # "VM is already running". We silently ignore the override and use
        # the construction-time annotator set.
        with self._lock:
            raw = self._model.annotate_text(text)
        return _normalize(raw)


# ── Output normalization ─────────────────────────────────────────────
def _normalize(raw: dict | list) -> list[dict]:
    """Convert py_vncorenlp's {int: list[dict]} output to a flat list of
    Sentence objects. py_vncorenlp uses 'wordForm' (not 'form') and embeds
    the dependency as token.head + token.depLabel; we synthesize a flat
    deps list [head, dep_index, deprel] per sentence for downstream parsers.
    """
    if isinstance(raw, dict):
        # py_vncorenlp returns {sentence_index (int): list[token_dicts]}
        sents_iter = sorted(raw.items(), key=lambda kv: int(kv[0]))
        sents = [v for _, v in sents_iter]
    elif isinstance(raw, list):
        sents = raw
    else:
        return []

    out: list[dict] = []
    for sent in sents:
        if not isinstance(sent, list):
            continue
        tokens: list[dict] = []
        deps: list[list[int]] = []
        for w in sent:
            if not isinstance(w, dict):
                continue
            idx = w.get("index")
            form = w.get("wordForm") or w.get("form") or w.get("word") or w.get("text") or ""
            pos = w.get("posTag") or w.get("pos")
            ner = w.get("nerLabel") or w.get("ner")
            head_raw = w.get("head")
            rel = w.get("depLabel") or w.get("deprel")
            try:
                idx = int(idx) if idx is not None else len(tokens) + 1
            except (TypeError, ValueError):
                idx = len(tokens) + 1
            head: int | None = None
            try:
                head = int(head_raw) if head_raw not in (None, "", "0") else None
            except (TypeError, ValueError):
                head = None
            tokens.append({
                "index": idx,
                "form": form,
                "posTag": pos,
                "nerLabel": ner,
                "head": head,
                "depLabel": rel,
            })
            if head is not None and rel:
                deps.append({"head": head, "dependent": idx, "deprel": str(rel)})
        out.append({"tokens": tokens, "deps": deps})
    return out


# ── FastAPI app ────────────────────────────────────────────────────────
app = FastAPI(title="VnCoreNLP Service", version="2.0.0")
_model = VnCoreNLPModel()
_rpc_lock = asyncio.Lock()


@app.on_event("startup")
def _startup() -> None:
    log.info("VnCoreNLP service starting on port %d (save_dir=%s)",
             HTTP_PORT, SAVE_DIR)


@app.on_event("shutdown")
def _shutdown() -> None:
    log.info("shutting down")


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "ready": _model.is_up,
        "jvm_up": _model.is_up,
        "model": "VnCoreNLP-1.2",
        "annotators": ANNOTATORS.split(","),
        "save_dir": str(SAVE_DIR),
    }


@app.get("/cache_stats")
def cache_stats() -> dict[str, int]:
    return _cache.stats()


@app.post("/annotate", response_model=AnnotateResponse)
async def annotate(req: AnnotateRequest) -> AnnotateResponse:
    if not req.text or not req.text.strip():
        return AnnotateResponse(sentences=[], elapsed_ms=0)
    annotators_key = ",".join(req.annotators) if req.annotators else ANNOTATORS
    key = hashlib.sha1((annotators_key + "::" + req.text).encode("utf-8")).hexdigest()
    cached = _cache.get(key)
    t0 = time.time()
    if cached is not None:
        return AnnotateResponse(
            sentences=[Sentence(**s) for s in cached],
            cached=True,
            elapsed_ms=int((time.time() - t0) * 1000),
        )
    try:
        async with _rpc_lock:
            sents = await asyncio.to_thread(_model.annotate_text, req.text,
                                             req.annotators)
    except Exception as e:
        log.exception("annotation failed")
        raise HTTPException(status_code=502, detail=f"annotation error: {e}")
    _cache.put(key, sents)
    return AnnotateResponse(
        sentences=[Sentence(**s) for s in sents],
        cached=False,
        elapsed_ms=int((time.time() - t0) * 1000),
    )


# ── CLI helper: warm the model on startup (optional) ───────────────
def _warm_model() -> int:
    """Load the model + run one tiny parse. Returns 0 on success."""
    try:
        _model.start()
        out = _model.annotate_text("Xin chào Việt Nam.")
    except Exception as e:
        print(f"vncorenlp: warmup failed: {e}", file=sys.stderr)
        return 1
    if not out:
        print("vncorenlp: warmup produced no output", file=sys.stderr)
        return 1
    print(f"vncorenlp: warmup OK — {len(out[0]['tokens'])} tokens in first sentence",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    if "--warm-once" in sys.argv:
        sys.exit(_warm_model())
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=HTTP_PORT, log_level="info")