// src/components/library/RelationshipGraph.tsx
// Lightweight, dependency-free force-directed graph of character
// relationships for the "Nhân vật" tab. Reads from the bible view
// (characters + relationships) and renders an elegant, interactive SVG.
//
// Design notes (archify-inspired, self-contained):
//   - Dark, calm canvas; nodes tinted by role (main = accent, supporting =
//     muted blue, minor = faint, crowd = ghosted).
//   - Edges labelled with the canonicalized relationship; hover a node to
//     highlight its ego network and dim the rest.
//   - Click a node to select it (parent shows the character card).
//   - No external graph lib — a tiny velocity Verlet simulation runs in
//     requestAnimationFrame so we keep the bundle small and the style fully
//     under our control.
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

const ROLE_COLOR: Record<string, string> = {
  main: '#f59e0b',
  supporting: '#38bdf8',
  minor: '#94a3b8',
  crowd: '#475569',
};

export function RelationshipGraph({ nodes, edges, width = 720, height = 460, onSelect, selectedId }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [pos, setPos] = useState<Record<string, Sim>>({});
  const rafRef = useRef<number | null>(null);
  const posRef = useRef<Record<string, Sim>>({});

  // Initialize positions in a circle.
  useEffect(() => {
    const init: Record<string, Sim> = {};
    const n = nodes.length || 1;
    nodes.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2;
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
  }, [nodes, width, height]);

  // Run a simple force simulation.
  useEffect(() => {
    if (nodes.length === 0) return;
    let frame = 0;
    const step = () => {
      const p = posRef.current;
      const ids = nodes.map((n) => n.id);
      const cx = width / 2;
      const cy = height / 2;

      // Repulsion between all pairs.
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
          a.vx += dx * force;
          a.vy += dy * force;
          b.vx -= dx * force;
          b.vy -= dy * force;
        }
      }
      // Attraction along edges.
      for (const e of edges) {
        const a = p[e.from];
        const b = p[e.to];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const target = 120;
        const force = (dist - target) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      // Centering + integrate + damping.
      for (const id of ids) {
        const s = p[id];
        if (!s) continue;
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
      if (frame < 400) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [nodes, edges, width, height]);

  const active = hover ?? selectedId ?? null;
  const ego = useMemo(() => {
    if (!active) return null;
    const set = new Set<string>([active]);
    for (const e of edges) {
      if (e.from === active) set.add(e.to);
      if (e.to === active) set.add(e.from);
    }
    return set;
  }, [active, edges]);

  const nameById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
        Chưa có nhân vật để vẽ sơ đồ quan hệ.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-border/60 bg-gradient-to-br from-slate-950/40 to-slate-900/20">
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        role="img"
        aria-label="Sơ đồ quan hệ nhân vật"
      >
        {/* Edges */}
        {edges.map((e) => {
          const a = pos[e.from];
          const b = pos[e.to];
          if (!a || !b) return null;
          const dim = ego && !(ego.has(e.from) && ego.has(e.to));
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={e.id} opacity={dim ? 0.12 : 0.7}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#64748b" strokeWidth={1.2} />
              <text
                x={mx}
                y={my - 3}
                fill="#cbd5e1"
                fontSize={9}
                textAnchor="middle"
                className="pointer-events-none select-none"
              >
                {e.relationship}
              </text>
            </g>
          );
        })}
        {/* Nodes */}
        {nodes.map((n) => {
          const s = pos[n.id];
          if (!s) return null;
          const dim = ego && !ego.has(n.id);
          const color = ROLE_COLOR[n.role ?? 'minor'] ?? ROLE_COLOR.minor;
          const isActive = n.id === active;
          const r = n.role === 'main' ? 13 : n.role === 'supporting' ? 10 : 7;
          return (
            <g
              key={n.id}
              transform={`translate(${s.x},${s.y})`}
              opacity={dim ? 0.18 : 1}
              className="cursor-pointer"
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(n.id === selectedId ? null : n.id)}
            >
              {isActive && <circle r={r + 5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.6} />}
              <circle r={r} fill={color} stroke="#0f172a" strokeWidth={1.5} />
              <title>{n.name}</title>
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
      </svg>
      <div className="absolute right-2 top-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        {(['main', 'supporting', 'minor', 'crowd'] as const).map((role) => (
          <span key={role} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: ROLE_COLOR[role] }} />
            {role === 'main' ? 'Chính' : role === 'supporting' ? 'Phụ' : role === 'minor' ? 'Vãng lai' : 'Đám đông'}
          </span>
        ))}
      </div>
    </div>
  );
}
