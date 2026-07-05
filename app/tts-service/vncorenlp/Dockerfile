# VnCoreNLP — Vietnamese word segmentation, POS, NER, dependency parsing.
# Used by the ebook-converter to extract (subject, verb, object) triples from
# literary Vietnamese text for speaker attribution.
#
# Architecture: we embed the VnCoreNLP JVM in-process via py_vncorenlp
# (which uses pyjnius as the JPype bridge), and expose it through a FastAPI
# HTTP server. This works because VnCoreNLP's jar is a batch CLI tool, not
# a long-lived server — there is no -p / -rpc flag. The only way to keep a
# JVM warm and query it is to embed it via pyjnius.
#
# The parser is NOT thread-safe (one JVM per process, shared between
# requests via a lock). We run a single FastAPI worker and serialize calls.
# To scale, run multiple containers behind a load balancer.
#
# Build:   docker build -t local/vncorenlp:1.2 ./vncorenlp
# Run:     docker run --rm -p 5030:5030 local/vncorenlp:1.2
#
# Healthcheck: GET /healthz → {"ready": true, "jvm_up": true} after first
# /annotate call (lazy-loaded).
#
# Image size: ~280 MB (eclipse-temurin:11-jre base ~180 MB + jar 27 MB +
# models 115 MB + py_vncorenlp + pyjnius).

FROM eclipse-temurin:11-jdk

# curl is needed by the docker-compose healthcheck; ca-certificates lets us
# call out to anything TLS (not used today, but cheap insurance).
# Python + pip are required to run the FastAPI wrapper. The base image is
# Ubuntu (eclipse-temurin), so we install whichever python3 the distro ships
# rather than pinning a version that may not exist on newer bases.
#
# We also need g++/make/python3-dev because pyjnius compiles a C extension
# against the local Python headers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates python3 python3-pip python3-venv \
        python3-dev g++ make \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        fastapi==0.115.0 uvicorn==0.30.6 httpx==0.27.0 \
        pyjnius==1.7.0 py_vncorenlp==0.1.4

WORKDIR /opt/vncorenlp

# Bundle the jar + models. py_vncorenlp expects the save_dir layout:
#   <save_dir>/VnCoreNLP-1.2.jar
#   <save_dir>/models/{wordsegmenter,postagger,dep,ner}/...
# So we COPY them flat into /opt/vncorenlp/ (not into a subdir).
COPY VnCoreNLP-1.2.jar .
COPY models/ ./models/

# FastAPI wrapper that exposes /annotate and /healthz.
COPY vncorenlp_server.py .

# JAVA_OPTS is read by vncorenlp_server.py and passed to jnius_config.
ENV JAVA_OPTS="-Xmx2g"

EXPOSE 5030

# Single worker, single thread — the parser is not thread-safe. To scale
# horizontally, run multiple containers behind a load balancer.
CMD ["python3", "vncorenlp_server.py"]