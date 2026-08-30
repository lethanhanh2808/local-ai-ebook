export type AnalysisPhase =
  | 'init'
  | 'parse'
  | 'regex'
  | 'local'
  | 'preflight'
  | 'llm'
  | 'fuse'
  | 'cache'
  | 'stat'
  | 'error';

export interface AnalysisLogLine {
  phase: AnalysisPhase;
  text: string;
  wallMs?: number;
  sinceLast?: number;
  meta?: Record<string, unknown>;
}

export const PHASE_LABEL: Record<AnalysisPhase, string> = {
  init: 'INIT',
  parse: 'PARSE',
  regex: 'REGEX',
  local: 'LOCAL',
  preflight: 'PING',
  llm: 'LLM',
  fuse: 'FUSE',
  cache: 'CACHE',
  stat: 'DONE',
  error: 'ERROR',
};

export const PHASE_VN: Record<AnalysisPhase, string> = {
  init: 'Khởi tạo',
  parse: 'Phân tích câu',
  regex: 'Regex',
  local: 'Hội thoại local',
  preflight: 'Ping oMLX',
  llm: 'LLM (oMLX)',
  fuse: 'Hợp nhất',
  cache: 'Cache',
  stat: 'Hoàn tất',
  error: 'Lỗi',
};

export const PHASE_BG: Record<AnalysisPhase, string> = {
  error: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
  llm: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  fuse: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  cache: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
  stat: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border-emerald-500/40',
  init: 'bg-muted text-muted-foreground border border-border border-border',
  parse: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  regex: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  local: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
  preflight: 'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30',
};
