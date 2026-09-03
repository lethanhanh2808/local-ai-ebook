'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface GraphNode {
  id: string;
  name: string;
  role?: 'main' | 'supporting' | 'minor' | 'crowd';
  gender?: 'male' | 'female' | 'unknown' | null;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width?: number;
  height?: number;
  onSelect?: (id: string | null) => void;
  selectedId?: string | null;
}

interface Sim {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface MergedEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  count: number;
  altLabels: Array<{ label: string; count: number }>;
}

const ROLE_COLOR: Record<string, string> = {
  main: '#f59e0b',
  supporting: '#38bdf8',
  minor: '#94a3b8',
  crowd: '#475569',
};

const ROLE_LABEL: Record<string, string> = {
  main: 'Chính',
  supporting: 'Phụ',
  minor: 'Vãng lai',
  crowd: 'Đám đông',
};
const ROLES: Array<'main' | 'supporting' | 'minor' | 'crowd'> = ['main', 'supporting', 'minor', 'crowd'];

/**
 * 2026-09-02 update: icons for relationship labels.
 * Order matters — first keyword that matches (case-insensitive substring)
 * wins. Adding a new keyword later is cheap; just keep this list in one
 * place so it can be extended without touching the rendering code.
 *
 * Each entry: { keywords: [...vn substrings], icon: emoji, fallbackColor }.
 * If nothing matches, we still get a coloured circular badge with the
 * first letter so no edge is label-less.
 */
interface RelationStyle {
  keywords: string[];
  icon: string;
  color: string;
}

const RELATION_ICONS: RelationStyle[] = [
  // Friend / ally (English: friend, ally, companion)
  { keywords: ['bạn', 'bạn bè', 'bạn thân', 'bạn đồng', 'đồng đội', 'đồng môn', 'huynh đệ', 'kết nghĩa', 'chiến hữu', 'tri kỷ', 'đồng minh', 'minh hữu', 'liên minh', 'đồng hành', 'cộng sự', 'ally', 'friend', 'companion', 'partner', 'comrade', 'buddy'], icon: '🤝', color: '#22c55e' },
  // Enemy / hostile
  { keywords: ['kẻ thù', 'thù', 'cừu', 'căm thù', 'hận', 'thù hận', 'đối địch', 'oan gia', 'oán', 'phản bội', 'mưu phản', 'phản đồ', 'enemy', 'hostile', 'foe', 'rival', 'antagonist', 'nemesis'], icon: '⚔️', color: '#ef4444' },
  // Romantic (love / crush)
  { keywords: ['yêu', 'người yêu', 'tình nhân', 'tình yêu', 'yêu thương', 'thương', 'thích', 'say mê', 'mê', 'lover', 'love', 'crush', 'romantic', 'beloved'], icon: '❤️', color: '#ec4899' },
  // Spouse / married
  { keywords: ['vợ chồng', 'chồng', 'vợ', 'cưới', 'hôn phu', 'hôn thê', 'phu thê', 'lương duyên', 'spouse', 'husband', 'wife', 'married', 'fiancé', 'fiancee'], icon: '💍', color: '#ec4899' },
  // Family
  { keywords: ['gia đình', 'cha', 'mẹ', 'bố', 'phụ thân', 'mẫu thân', 'con', 'anh', 'chị', 'em', 'chú', 'bác', 'cô', 'dì', 'ông', 'bà', 'ruột', 'huyết thống', 'song sinh', 'anh trai', 'em trai', 'chị gái', 'em gái', 'anh em', 'family', 'father', 'mother', 'parent', 'son', 'daughter', 'brother', 'sister', 'sibling', 'uncle', 'aunt', 'cousin', 'twin'], icon: '👨‍👩‍👧', color: '#a78bfa' },
  // Master / disciple (wuxia common)
  { keywords: ['sư đồ', 'đệ tử', 'đồ đệ', 'sư phụ', 'thầy', 'trò', 'môn phái', 'truyền nhân', 'sư huynh', 'sư muội', 'sư tỷ', 'sư huynh đệ', 'lão sư', 'thầy dạy', 'đại sư', 'sư tổ', 'master', 'disciple', 'mentor', 'student', 'apprentice', 'teacher', 'shifu', 'shijie', 'shidi'], icon: '📜', color: '#60a5fa' },
  // Rival (non-hostile competition)
  { keywords: ['đối thủ', 'cạnh tranh', 'competitor', 'opponent'], icon: '🥊', color: '#f97316' },
  // Ruler / superior (sovereign)
  { keywords: ['cấp trên', 'chủ nhân', 'lãnh đạo', 'tông chủ', 'môn chủ', 'bang chủ', 'vua', 'hoàng đế', 'nữ đế', 'đế vương', 'sovereign', 'ruler', 'lord', 'king', 'queen', 'emperor', 'master of'], icon: '👑', color: '#facc15' },
  // Subordinate / servant
  { keywords: ['cấp dưới', 'thuộc hạ', 'nô tài', 'gia nhân', 'hầu cận', 'thị vệ', 'subordinate', 'servant', 'retainer', 'guard'], icon: '🧎', color: '#94a3b8' },
  // Colleague / co-worker
  { keywords: ['đồng bạc', 'công nhân', 'đồng nghiệp', 'cùng môn', 'bạn cùng', 'colleague', 'coworker', 'co-worker'], icon: '👥', color: '#94a3b8' },
  // Healer / doctor
  { keywords: ['thầy thuốc', 'y sư', 'thần y', 'lương y', 'dược', 'doctor', 'healer', 'physician'], icon: '💊', color: '#34d399' },
  // Senior / big brother
  { keywords: ['đại ca', 'anh cả', 'trưởng', 'trưởng môn', 'lão đại', 'senior', 'elder'], icon: '🫅', color: '#facc15' },
];

const DEFAULT_RELATION: RelationStyle = {
  keywords: [],
  icon: '🔗',
  color: '#64748b',
};

/** Normalise Vietnamese text for fuzzy keyword matching:
 *  - lowercase
 *  - collapse whitespace
 *  - strip a handful of filler suffixes the LLM tends to append
 *    ("-nhau", "trong tiểu thuyết", "trong truyện")
 *  Returns the canonical label used for matching; display keeps the
 *  original string the user / LLM emitted.
 */
function normaliseLabel(s: string): string {
  let t = s.toLowerCase().trim();
  // Strip quotes and dashes.
  t = t.replace(/["'\u2018\u2019\u201c\u201d\-–—]/g, ' ');
  // Collapse whitespace.
  t = t.replace(/\s+/g, ' ').trim();
  // Common LLM suffixes that don't change the meaning.
  t = t.replace(/\s*trong\s+tieu\s+thuyet\s*$/g, '');
  t = t.replace(/\s*trong\s+truyen\s*$/g, '');
  t = t.replace(/\s*\-\s*nhau\s*$/g, '-nhau');
  return t;
}

function lookupRelationStyle(label: string): RelationStyle {
  const norm = normaliseLabel(label);
  if (!norm) return DEFAULT_RELATION;
  for (const style of RELATION_ICONS) {
    for (const kw of style.keywords) {
      if (norm.includes(kw)) return style;
    }
  }
  return DEFAULT_RELATION;
}

function pairKey(a: string, b: string, label: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return x + '|' + y + '|' + label;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;

export function RelationshipGraph({ nodes, edges, width = 720, height = 460, onSelect, selectedId }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Set<'main' | 'supporting' | 'minor' | 'crowd'>>(new Set());
  const [pos, setPos] = useState<Record<string, Sim>>({});
  const rafRef = useRef<number | null>(null);
  const posRef = useRef<Record<string, Sim>>({});

  // Pan + zoom state. We store a transform (zoom + tx/ty in screen px
  // relative to the SVG centre) and apply it via a <g> wrapper around
  // all visual content. The inner force-simulation continues to run in
  // its own coordinate system — we don't have to project anything back.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; basePanX: number; basePanY: number; moved: boolean } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Per-node drag state. When the user grabs a character we capture the
  // pointer at the SVG level (so the move/up events keep flowing even if
  // the cursor leaves the node) and stash the offset between the cursor
  // and the node centre so the node doesn't snap to the cursor.
  const nodeDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
    /** Last screen coords — we diff against these to compute dx/dy. */
    lastX: number;
    lastY: number;
  } | null>(null);
  const [isNodeDragging, setIsNodeDragging] = useState(false);

  /** IDs of nodes the user has manually positioned. Pinned nodes skip
   *  force integration entirely so the simulation doesn't drag them
   *  back to their original spot. */
  const pinnedRef = useRef<Set<string>>(new Set());
  const [pinnedCount, setPinnedCount] = useState(0);

  const mergedEdges = useMemo<MergedEdge[]>(() => {
    const groups = new Map<string, MergedEdge>();
    for (const e of edges) {
      const id = pairKey(e.from, e.to, e.relationship);
      const existing = groups.get(id);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(id, {
          id,
          from: e.from < e.to ? e.from : e.to,
          to: e.from < e.to ? e.to : e.from,
          label: e.relationship,
          count: 1,
          altLabels: [],
        });
      }
    }
    const byPair = new Map<string, MergedEdge[]>();
    for (const m of groups.values()) {
      const k = m.from + '|' + m.to;
      const arr = byPair.get(k) ?? [];
      arr.push(m);
      byPair.set(k, arr);
    }
    for (const arr of byPair.values()) {
      if (arr.length <= 1) continue;
      arr.sort((a, b) => b.count - a.count);
      const dom = arr[0];
      for (let i = 1; i < arr.length; i++) {
        dom.altLabels.push({ label: arr[i].label, count: arr[i].count });
      }
    }
    return Array.from(groups.values());
  }, [edges]);

  // Pre-compute the icon style for each merged edge once, so we don't
  // hit the keyword map on every re-render frame.
  const mergedEdgeStyles = useMemo(() => {
    return mergedEdges.map((e) => ({ edge: e, style: lookupRelationStyle(e.label) }));
  }, [mergedEdges]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const m of mergedEdges) {
      d.set(m.from, (d.get(m.from) ?? 0) + 1);
      d.set(m.to, (d.get(m.to) ?? 0) + 1);
    }
    return d;
  }, [mergedEdges]);

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (q && !n.name.toLowerCase().includes(q) && !n.id.includes(q)) return false;
      if (roleFilter.size > 0 && !roleFilter.has((n.role ?? 'minor') as 'main' | 'supporting' | 'minor' | 'crowd')) {
        if ((degree.get(n.id) ?? 0) > 0) return false;
      }
      return true;
    });
  }, [nodes, search, roleFilter, degree]);

  const filteredEdges = useMemo(() => {
    const ids = new Set(filteredNodes.map((n) => n.id));
    return mergedEdgeStyles.filter((m) => ids.has(m.edge.from) && ids.has(m.edge.to));
  }, [mergedEdgeStyles, filteredNodes]);

  const connectedNodes = useMemo(() => {
    return filteredNodes.filter((n) => (degree.get(n.id) ?? 0) > 0);
  }, [filteredNodes, degree]);

  const isolatedNodes = useMemo(() => {
    return filteredNodes.filter((n) => (degree.get(n.id) ?? 0) === 0);
  }, [filteredNodes, degree]);

  const toggleRole = (r: 'main' | 'supporting' | 'minor' | 'crowd') => {
    setRoleFilter((prev) => {
      const n = new Set(prev);
      if (n.has(r)) n.delete(r);
      else n.add(r);
      return n;
    });
  };

  // ----- Pan / zoom handlers -----

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2))), []);

  /** Convert a screen-space (clientX/clientY) point to the inner
   *  coordinate space we render in. Used by wheel-zoom so the zoom
   *  anchors around the cursor position rather than always the centre.
   */
  const screenToInner = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const sx = (clientX - rect.left) * (width / rect.width);
      const sy = (clientY - rect.top) * (height / rect.height);
      // Inverse of: screen = (inner - cx) * zoom + cx + pan
      const cx = width / 2;
      const cy = height / 2;
      return {
        x: (sx - cx - pan.x) / zoom + cx,
        y: (sy - cy - pan.y) / zoom + cy,
      };
    },
    [width, height, pan.x, pan.y, zoom],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      // Trackpad pinch zooms come through as ctrlKey+wheel.
      if (!e.ctrlKey && Math.abs(e.deltaY) < 50) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      setZoom((prev) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(prev + dir * ZOOM_STEP).toFixed(2)));
        // Re-anchor pan so the inner point under the cursor stays put.
        const svg = svgRef.current;
        if (!svg) return next;
        const rect = svg.getBoundingClientRect();
        const sx = (e.clientX - rect.left) * (width / rect.width);
        const sy = (e.clientY - rect.top) * (height / rect.height);
        const cx = width / 2;
        const cy = height / 2;
        // We want (sx - cx) = (anchorInner - cx) * next + newPanX
        const anchor = screenToInner(e.clientX, e.clientY);
        const newPanX = sx - cx - (anchor.x - cx) * next;
        const newPanY = sy - cy - (anchor.y - cy) * next;
        setPan({ x: newPanX, y: newPanY });
        return next;
      });
    },
    [screenToInner, width, height],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Only respond to left mouse button / single touch / pen.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // Skip if the user clicked a node (those have their own onClick).
      const target = e.target as Element;
      if (target.closest('[data-node="1"]')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startY: e.clientY, basePanX: pan.x, basePanY: pan.y, moved: false };
      setIsDragging(true);
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Node drag has priority — pan drag only runs when no node is held.
      const nd = nodeDragRef.current;
      if (nd && nd.pointerId === e.pointerId) {
        // Convert the screen-space pointer to inner coordinates using
        // the same projection the wheel-zoom anchor uses, so the node
        // tracks the cursor 1:1 even when the user has panned/zoomed.
        const inner = screenToInner(e.clientX, e.clientY);
        const dx = inner.x - nd.startX;
        const dy = inner.y - nd.startY;
        if (!nd.moved && Math.hypot(dx, dy) < 0.5) return;
        nd.moved = true;
        nd.lastX = e.clientX;
        nd.lastY = e.clientY;
        const p = posRef.current;
        const node = p[nd.id];
        if (node) {
          const newX = Math.max(28, Math.min(width - 28, inner.x + nd.offsetX));
          const newY = Math.max(24, Math.min(height - 24, inner.y + nd.offsetY));
          node.x = newX;
          node.y = newY;
          node.vx = 0;
          node.vy = 0;
          // Skip setPos while dragging — that's 60+ React renders per
          // second. Update the ref live and force one render when the
          // gesture ends. The visible position still updates because
          // the SVG <g transform> is bound to pos[id], and we re-set
          // pos only on key moves to avoid flicker; force one re-render
          // here so the user sees the node tracking the cursor.
          setPos({ ...p });
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      setPan({ x: d.basePanX + dx, y: d.basePanY + dy });
    },
    [screenToInner, width, height],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Finish node drag first.
    const nd = nodeDragRef.current;
    if (nd && nd.pointerId === e.pointerId) {
      // Pin the node so the force simulation doesn't snap it back.
      if (nd.moved) {
        pinnedRef.current.add(nd.id);
        setPinnedCount(pinnedRef.current.size);
      }
      nodeDragRef.current = null;
      setIsNodeDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already have been released — ignore.
      }
      // Suppress the synthetic click that follows a drag.
      if (nd.moved) {
        e.preventDefault();
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', swallow, { once: true, capture: true });
      }
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already have been released — ignore.
    }
    // Suppress the synthetic click that follows a drag.
    if (d?.moved) {
      e.preventDefault();
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { once: true, capture: true });
    }
  }, []);

  /** Called by each node's onPointerDown. Sets up the drag bookkeeping
   *  and starts capturing pointer events at the SVG level so the move/
   *  up events keep flowing even if the cursor leaves the node. */
  const onNodePointerDown = useCallback(
    (e: React.PointerEvent<SVGGElement>, id: string) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.stopPropagation();
      // Capture at the SVG so we don't lose events when the cursor
      // leaves the node's bounding box mid-drag.
      try {
        (svgRef.current as unknown as Element).setPointerCapture(e.pointerId);
      } catch {
        // pointer capture is optional — without it we still get events
        // as long as the cursor stays over the SVG element.
      }
      const inner = screenToInner(e.clientX, e.clientY);
      const node = posRef.current[id];
      const offsetX = node ? node.x - inner.x : 0;
      const offsetY = node ? node.y - inner.y : 0;
      nodeDragRef.current = {
        id,
        pointerId: e.pointerId,
        startX: inner.x,
        startY: inner.y,
        offsetX,
        offsetY,
        moved: false,
        lastX: e.clientX,
        lastY: e.clientY,
      };
      setIsNodeDragging(true);
    },
    [screenToInner],
  );

  /** Release all user-pinned nodes and re-run the initial circle layout.
   *  Triggered by the "Tự sắp xếp" button in the toolbar. */
  const relayout = useCallback(() => {
    pinnedRef.current.clear();
    setPinnedCount(0);
    const init: Record<string, Sim> = {};
    const cn = connectedNodes.length || 1;
    connectedNodes.forEach((node, i) => {
      const angle = (i / cn) * Math.PI * 2;
      const r = Math.min(width, height) * 0.32;
      init[node.id] = {
        x: width / 2 + Math.cos(angle) * r,
        y: height / 2 + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      };
    });
    posRef.current = init;
    setPos(init);
  }, [connectedNodes, width, height]);

  // ----- Init positions: circle around centre -----
  useEffect(() => {
    const init: Record<string, Sim> = {};
    const cn = connectedNodes.length || 1;
    connectedNodes.forEach((node, i) => {
      const angle = (i / cn) * Math.PI * 2;
      const r = Math.min(width, height) * 0.32;
      init[node.id] = {
        x: width / 2 + Math.cos(angle) * r,
        y: height / 2 + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      };
    });
    posRef.current = init;
    setPos(init);
  }, [connectedNodes, width, height]);

  // ----- Force simulation -----
  useEffect(() => {
    if (connectedNodes.length === 0) return;
    let frame = 0;
    const pinned = pinnedRef.current;
    const step = () => {
      const p = posRef.current;
      const ids = connectedNodes.map((n) => n.id);
      const cx = width / 2;
      const cy = height / 2;

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = p[ids[i]];
          const b = p[ids[j]];
          if (!a || !b) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          const force = 6000 / (dist * dist);
          dx /= dist;
          dy /= dist;
          // Skip pushing pinned nodes — they stay put, but they DO
          // still push others around (one-sided repulsion).
          if (!pinned.has(ids[i])) {
            a.vx += dx * force;
            a.vy += dy * force;
          }
          if (!pinned.has(ids[j])) {
            b.vx -= dx * force;
            b.vy -= dy * force;
          }
        }
      }
      for (const m of filteredEdges) {
        const e = m.edge;
        const a = p[e.from];
        const b = p[e.to];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const target = 120;
        const force = (dist - target) * 0.012 * Math.min(2, e.count);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!pinned.has(e.from)) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!pinned.has(e.to)) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      for (const id of ids) {
        const s = p[id];
        if (!s) continue;
        if (pinned.has(id)) {
          // Pinned: clear velocity so it stays exactly where the user
          // dropped it (no jitter, no drift).
          s.vx = 0;
          s.vy = 0;
          continue;
        }
        s.vx += (cx - s.x) * 0.002;
        s.vy += (cy - s.y) * 0.002;
        s.vx *= 0.85;
        s.vy *= 0.85;
        s.x += s.vx;
        s.y += s.vy;
        s.x = Math.max(28, Math.min(width - 28, s.x));
        s.y = Math.max(24, Math.min(height - 24, s.y));
      }
      setPos({ ...p });
      frame++;
      if (frame < 400) {
        // Pause simulation while the user is actively dragging so the
        // graph doesn't keep "swimming" under their finger.
        if (dragRef.current || nodeDragRef.current) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = requestAnimationFrame(step);
        }
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [connectedNodes, filteredEdges, width, height]);

  const active = hover ?? selectedId ?? null;
  const ego = useMemo(() => {
    if (!active) return null;
    const set = new Set<string>([active]);
    for (const m of filteredEdges) {
      if (m.edge.from === active) set.add(m.edge.to);
      if (m.edge.to === active) set.add(m.edge.from);
    }
    return set;
  }, [active, filteredEdges]);

  const roleCounts = useMemo(() => {
    const c: Record<string, number> = { main: 0, supporting: 0, minor: 0, crowd: 0 };
    for (const n of nodes) {
      const r = (n.role ?? 'minor') as string;
      c[r] = (c[r] ?? 0) + 1;
    }
    return c;
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
        Chưa có nhân vật để vẽ sơ đồ quan hệ.
      </div>
    );
  }

  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-grab';
  const transformStr = `translate(${pan.x},${pan.y}) scale(${zoom})`;

  return (
    <div className="space-y-3">
      {/* Toolbar: search + role chips + zoom controls + counts */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Tìm nhân vật…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 w-40 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
        />
        <div className="flex items-center gap-1">
          {ROLES.map((r) => {
            const isActive = roleFilter.has(r);
            return (
              <button
                key={r}
                onClick={() => toggleRole(r)}
                title={(isActive ? 'Bỏ lọc' : 'Chỉ hiện') + ' ' + (ROLE_LABEL[r] ?? r) + ' (' + (roleCounts[r] ?? 0) + ')'}
                className={cn(
                  'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition',
                  isActive
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: ROLE_COLOR[r] }} />
                {ROLE_LABEL[r]}
                <span className="opacity-70">({roleCounts[r] ?? 0})</span>
              </button>
            );
          })}
          {roleFilter.size > 0 && (
            <button
              onClick={() => setRoleFilter(new Set())}
              className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Xóa lọc
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            title="Thu nhỏ (Ctrl + scroll cũng được)"
            className="px-1.5 py-0.5 text-base leading-none text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            −
          </button>
          <button
            onClick={resetView}
            title="Đặt lại góc nhìn"
            className="px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            title="Phóng to"
            className="px-1.5 py-0.5 text-base leading-none text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            +
          </button>
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {filteredEdges.length} cạnh · {connectedNodes.length} có quan hệ · {isolatedNodes.length} cô lập
          {mergedEdges.length !== edges.length && ' · ' + (edges.length - mergedEdges.length) + ' trùng lặp đã gộp'}
        </span>
        {pinnedCount > 0 && (
          <button
            onClick={relayout}
            title="Thả các nhân vật đã ghim và chạy lại bố cục"
            className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:border-primary hover:text-foreground"
          >
            Tự sắp xếp lại ({pinnedCount})
          </button>
        )}
      </div>

      {/* Main graph canvas. Drag to pan, Ctrl+wheel (or the +/- buttons
          above) to zoom. Nodes have data-node="1" so the drag handler
          can ignore clicks on them. */}
      <div className="relative overflow-hidden rounded-lg border border-border/60 bg-gradient-to-br from-slate-950/40 to-slate-900/20 select-none">
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${width} ${height}`}
          className={cn('block h-auto w-full touch-none', cursorClass)}
          role="img"
          aria-label="Sơ đồ quan hệ nhân vật"
          onWheel={handleWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* Pan/zoom group wraps all visual content. */}
          <g transform={transformStr} style={{ transformOrigin: 'center' }}>
            {/* Edges (merged + de-duplicated). Icon badge in the middle
                of each edge instead of a long text label. */}
            {filteredEdges.map((m) => {
              const e = m.edge;
              const style = m.style;
              const a = pos[e.from];
              const b = pos[e.to];
              if (!a || !b) return null;
              const dim = ego && !(ego.has(e.from) && ego.has(e.to));
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              const conflict = e.altLabels.length > 0;
              const strokeW = 1.2 + Math.min(1.6, (e.count - 1) * 0.4);
              return (
                <g key={e.id} opacity={dim ? 0.12 : 0.85}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={conflict ? '#f59e0b' : style.color}
                    strokeWidth={strokeW}
                    strokeDasharray={conflict ? '4 3' : undefined}
                  />
                  {/* Icon badge in the middle of the edge. */}
                  <g transform={`translate(${mx},${my})`}>
                    <circle
                      r={9}
                      fill="#0f172a"
                      stroke={style.color}
                      strokeWidth={1.5}
                      opacity={0.95}
                    />
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={11}
                      className="pointer-events-none select-none"
                      aria-label={style.keywords.join(', ') || e.label}
                    >
                      <title>{e.label}{e.count > 1 && ` (x${e.count})`}</title>
                      {style.icon}
                    </text>
                    {e.count > 1 && (
                      <text
                        x={9}
                        y={-7}
                        fontSize={7}
                        fill="#94a3b8"
                        className="pointer-events-none select-none"
                      >
                        x{e.count}
                      </text>
                    )}
                  </g>
                  {conflict && (
                    <text
                      x={mx}
                      y={my + 16}
                      fontSize={7}
                      textAnchor="middle"
                      fill="#fbbf24"
                      className="pointer-events-none select-none"
                    >
                      +{e.altLabels.map((a) => a.label + ' (' + a.count + ')').join(', ')}
                    </text>
                  )}
                </g>
              );
            })}
            {/* Nodes */}
            {connectedNodes.map((n) => {
              const s = pos[n.id];
              if (!s) return null;
              const dim = ego && !ego.has(n.id);
              const color = ROLE_COLOR[n.role ?? 'minor'] ?? ROLE_COLOR.minor;
              const isActive = n.id === active;
              const isHeld = isNodeDragging && nodeDragRef.current?.id === n.id;
              const isPinned = pinnedRef.current.has(n.id);
              const r = n.role === 'main' ? 13 : n.role === 'supporting' ? 10 : 7;
              return (
                <g
                  key={n.id}
                  data-node="1"
                  transform={`translate(${s.x},${s.y})`}
                  opacity={dim ? 0.18 : 1}
                  className={cn(isHeld ? 'cursor-grabbing' : 'cursor-grab')}
                  style={{ touchAction: 'none' }}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect?.(n.id === selectedId ? null : n.id);
                  }}
                  onPointerDown={(e) => onNodePointerDown(e, n.id)}
                >
                  {/* Active ring when selected. */}
                  {isActive && <circle r={r + 5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />}
                  {/* Held ring (stronger, brighter) when the user is dragging. */}
                  {isHeld && <circle r={r + 8} fill="none" stroke={color} strokeWidth={2.2} opacity={0.85} />}
                  {/* Pinned marker: small dot under the node so the user
                      knows this character is now pinned to its spot. */}
                  {isPinned && !isHeld && (
                    <circle cx={0} cy={r + 5} r={2} fill={color} opacity={0.85} />
                  )}
                  <circle r={r} fill={color} stroke="#0f172a" strokeWidth={1.5} />
                  <title>{n.name}{isPinned ? ' (đã ghim — bấm "Tự sắp xếp" để thả)' : ''}</title>
                  <text
                    y={r + 11}
                    fill="#e2e8f0"
                    fontSize={9.5}
                    textAnchor="middle"
                    className="pointer-events-none select-none"
                  >
                    {n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        {connectedNodes.length > 1 && (
          <p className="pointer-events-none absolute bottom-1 left-2 text-[9px] text-muted-foreground/70">
            Kéo để di chuyển · Ctrl + cuộn để phóng to
          </p>
        )}
      </div>

      {/* Isolated-character strip (faded row below the canvas) */}
      {isolatedNodes.length > 0 && (
        <div className="rounded-lg border border-dashed border-border/40 bg-muted/20 p-2">
          <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              Nhân vật cô lập · <span className="font-semibold text-foreground/70">{isolatedNodes.length}</span> chưa có quan hệ nào
            </span>
            <span>Bấm để xem chi tiết</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {isolatedNodes.map((n) => {
              const isActive = n.id === active;
              const color = ROLE_COLOR[n.role ?? 'minor'] ?? ROLE_COLOR.minor;
              return (
                <button
                  key={n.id}
                  onClick={() => onSelect?.(n.id === selectedId ? null : n.id)}
                  className={cn(
                    'flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition',
                    isActive
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border/40 text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}
                  title={n.name + ' · ' + (ROLE_LABEL[n.role ?? 'minor'] ?? n.role)}
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
                  {n.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
