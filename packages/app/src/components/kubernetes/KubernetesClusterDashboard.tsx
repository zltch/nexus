import { useApi } from '@backstage/core-plugin-api';
import {
  InfoCard,
  Progress,
  ResponseErrorPanel,
  WarningPanel,
} from '@backstage/core-components';
import {
  kubernetesApiRef,
  type KubernetesApi,
} from '@backstage/plugin-kubernetes-react';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Grid from '@material-ui/core/Grid';
import TextField from '@material-ui/core/TextField';
import Chip from '@material-ui/core/Chip';
import FormControl from '@material-ui/core/FormControl';
import InputLabel from '@material-ui/core/InputLabel';
import LinearProgress from '@material-ui/core/LinearProgress';
import MenuItem from '@material-ui/core/MenuItem';
import Paper from '@material-ui/core/Paper';
import Select from '@material-ui/core/Select';
import Tab from '@material-ui/core/Tab';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableContainer from '@material-ui/core/TableContainer';
import TableHead from '@material-ui/core/TableHead';
import TablePagination from '@material-ui/core/TablePagination';
import TableRow from '@material-ui/core/TableRow';
import TableSortLabel from '@material-ui/core/TableSortLabel';
import Tabs from '@material-ui/core/Tabs';
import Typography from '@material-ui/core/Typography';
import { makeStyles } from '@material-ui/core/styles';
import GetAppIcon from '@material-ui/icons/GetApp';
import RefreshIcon from '@material-ui/icons/Refresh';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

const useStyles = makeStyles(theme => ({
  hubbleStrip: {
    background: `linear-gradient(90deg, ${theme.palette.secondary.dark} 0%, ${theme.palette.primary.dark} 100%)`,
    color: theme.palette.common.white,
    padding: theme.spacing(1.5, 2),
    borderRadius: theme.shape.borderRadius,
    marginBottom: theme.spacing(2),
  },
  statGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  nsBarTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.palette.action.hover,
    overflow: 'hidden',
    marginTop: theme.spacing(0.5),
  },
  nsBarFill: {
    height: '100%',
    borderRadius: 4,
    background: `linear-gradient(90deg, ${theme.palette.secondary.main}, ${theme.palette.primary.main})`,
    transition: 'width 0.3s ease',
  },
  tableToolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
    marginTop: theme.spacing(1),
  },
}));

const ROWS_PER_PAGE_STORAGE_KEY = 'nexus.kubernetesDashboard.rowsPerPage';

type ObjectMeta = { name?: string; namespace?: string };

type SortConfig = { id: string; desc: boolean };

type PodRow = {
  meta: ObjectMeta;
  phase: string;
  restarts: number;
  node?: string;
};

type ServiceRow = {
  meta: ObjectMeta;
  type: string;
  clusterIP: string;
  ports: string;
};

/** Replicas ready / desired for sorting */
type ReplicaWorkloadRow = {
  meta: ObjectMeta;
  readyLabel: string;
  ready: number;
  desired: number;
};

type DaemonSetRow = {
  meta: ObjectMeta;
  readyLabel: string;
  ready: number;
  desired: number;
};

type JobRow = {
  meta: ObjectMeta;
  completionsLabel: string;
  succeeded: number;
  desired: number;
  active: number;
  failed: number;
};

type CronJobRow = {
  meta: ObjectMeta;
  schedule: string;
  suspended: boolean;
  lastSchedule: string;
};

type IngressRow = {
  meta: ObjectMeta;
  hosts: string;
  ingressClass: string;
  loadBalancer: string;
};

type HpaRow = {
  meta: ObjectMeta;
  scaleTarget: string;
  min: number;
  max: number;
  current: number;
  desired: number;
};

type EventRow = {
  meta: ObjectMeta;
  uid?: string;
  eventType: string;
  reason: string;
  involved: string;
  message: string;
  lastTs: string;
  lastTsMs: number;
};

type ClusterSnapshot = {
  pods: PodRow[];
  services: ServiceRow[];
  deployments: ReplicaWorkloadRow[];
  statefulSets: ReplicaWorkloadRow[];
  daemonSets: DaemonSetRow[];
  jobs: JobRow[];
  cronJobs: CronJobRow[];
  /** Argo Rollouts CRD; empty when API is missing or forbidden */
  rollouts: ReplicaWorkloadRow[];
  ingresses: IngressRow[];
  hpas: HpaRow[];
  /** Recent events, newest first (capped) */
  events: EventRow[];
  namespaces: string[];
  /** Non-fatal list API issues (other tables still load) */
  fetchWarnings: string[];
};

type ListResult = { items: unknown[]; warning?: string };

async function loadList(
  api: KubernetesApi,
  clusterName: string,
  path: string,
): Promise<ListResult> {
  try {
    const res = await api.proxy({
      clusterName,
      path,
      init: { method: 'GET' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        items: [],
        warning: `${res.status} ${res.statusText} ${text.slice(0, 240)}`,
      };
    }
    const body = (await res.json()) as { items?: unknown[] };
    return { items: body.items ?? [] };
  } catch (e) {
    return {
      items: [],
      warning: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseEventTime(ev: {
  eventTime?: string;
  lastTimestamp?: string;
  firstTimestamp?: string;
}): { label: string; ms: number } {
  const raw = ev.eventTime || ev.lastTimestamp || ev.firstTimestamp || '';
  const ms = raw ? Date.parse(raw) : 0;
  return { label: raw || '—', ms: Number.isFinite(ms) ? ms : 0 };
}

function mapIngress(ing: {
  metadata?: ObjectMeta;
  spec?: {
    ingressClassName?: string;
    rules?: { host?: string; http?: { paths?: unknown[] } }[];
  };
  status?: {
    loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] };
  };
}): IngressRow {
  const hosts = new Set<string>();
  for (const r of ing.spec?.rules ?? []) {
    if (r.host) {
      hosts.add(r.host);
    }
  }
  const lb =
    ing.status?.loadBalancer?.ingress
      ?.map(x => x.hostname || x.ip || '')
      .filter(Boolean)
      .join(', ') || '—';
  return {
    meta: ing.metadata ?? {},
    hosts: [...hosts].join(', ') || '*',
    ingressClass: ing.spec?.ingressClassName ?? '—',
    loadBalancer: lb,
  };
}

function mapHpa(h: {
  metadata?: ObjectMeta;
  spec?: {
    scaleTargetRef?: { kind?: string; name?: string };
    minReplicas?: number;
    maxReplicas?: number;
  };
  status?: {
    currentReplicas?: number;
    desiredReplicas?: number;
  };
}): HpaRow {
  const ref = h.spec?.scaleTargetRef;
  const target = ref ? `${ref.kind ?? '?'}/${ref.name ?? '?'}` : '—';
  return {
    meta: h.metadata ?? {},
    scaleTarget: target,
    min: h.spec?.minReplicas ?? 0,
    max: h.spec?.maxReplicas ?? 0,
    current: h.status?.currentReplicas ?? 0,
    desired: h.status?.desiredReplicas ?? h.status?.currentReplicas ?? 0,
  };
}

function mapEvent(ev: {
  metadata?: ObjectMeta & { uid?: string };
  involvedObject?: { kind?: string; namespace?: string; name?: string };
  type?: string;
  reason?: string;
  message?: string;
  eventTime?: string;
  lastTimestamp?: string;
  firstTimestamp?: string;
}): EventRow {
  const ns = ev.involvedObject?.namespace ?? ev.metadata?.namespace ?? '';
  const { label, ms } = parseEventTime(ev);
  const inv = ev.involvedObject;
  const involved = inv?.name
    ? `${inv.kind ?? 'Object'}/${inv.namespace ? `${inv.namespace}/` : ''}${inv.name}`
    : '—';
  return {
    meta: {
      namespace: ns,
      name: ev.metadata?.name ?? '—',
    },
    uid: ev.metadata?.uid,
    eventType: ev.type ?? '—',
    reason: ev.reason ?? '—',
    involved,
    message: (ev.message ?? '').replace(/\s+/g, ' ').slice(0, 240),
    lastTs: label,
    lastTsMs: ms,
  };
}

async function loadHpaRows(
  api: KubernetesApi,
  clusterName: string,
): Promise<{ rows: HpaRow[]; warning?: string }> {
  const v2 = await loadList(
    api,
    clusterName,
    '/apis/autoscaling/v2/horizontalpodautoscalers',
  );
  if (!v2.warning || !/404|not\s*found/i.test(v2.warning)) {
    return {
      rows: v2.items.map(h => mapHpa(h as never)),
      warning: v2.warning,
    };
  }
  const v1 = await loadList(
    api,
    clusterName,
    '/apis/autoscaling/v1/horizontalpodautoscalers',
  );
  return {
    rows: v1.items.map(h => mapHpa(h as never)),
    warning: v1.warning ?? v2.warning,
  };
}

function escapeCsvCell(v: string | number | undefined): string {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const lines = [
    header.map(escapeCsvCell).join(','),
    ...rows.map(r => r.map(escapeCsvCell).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  URL.revokeObjectURL(url);
}

function mapPod(p: {
  metadata?: ObjectMeta;
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    hostIP?: string;
    containerStatuses?: { restartCount?: number }[];
  };
}): PodRow {
  const restarts =
    p.status?.containerStatuses?.reduce(
      (n, c) => n + (c.restartCount ?? 0),
      0,
    ) ?? 0;
  return {
    meta: p.metadata ?? {},
    phase: p.status?.phase ?? 'Unknown',
    restarts,
    node: p.spec?.nodeName ?? p.status?.hostIP,
  };
}

function mapService(s: {
  metadata?: ObjectMeta;
  spec?: {
    type?: string;
    clusterIP?: string;
    ports?: { port?: number; protocol?: string; name?: string }[];
  };
}): ServiceRow {
  const ports =
    s.spec?.ports
      ?.map(
        pr =>
          `${pr.port ?? ''}/${pr.protocol ?? 'TCP'}${pr.name ? ` (${pr.name})` : ''}`,
      )
      .join(', ') ?? '—';
  return {
    meta: s.metadata ?? {},
    type: s.spec?.type ?? '—',
    clusterIP: s.spec?.clusterIP ?? '—',
    ports,
  };
}

function mapReplicaWorkload(d: {
  metadata?: ObjectMeta;
  spec?: { replicas?: number };
  status?: {
    readyReplicas?: number;
    replicas?: number;
    availableReplicas?: number;
  };
}): ReplicaWorkloadRow {
  const want = d.spec?.replicas ?? 0;
  const ready = d.status?.readyReplicas ?? 0;
  return {
    meta: d.metadata ?? {},
    readyLabel: `${ready}/${want}`,
    ready,
    desired: want,
  };
}

function mapDaemonSet(d: {
  metadata?: ObjectMeta;
  status?: {
    numberReady?: number;
    desiredNumberScheduled?: number;
    currentNumberScheduled?: number;
  };
}): DaemonSetRow {
  const want = d.status?.desiredNumberScheduled ?? 0;
  const ready = d.status?.numberReady ?? 0;
  return {
    meta: d.metadata ?? {},
    readyLabel: `${ready}/${want}`,
    ready,
    desired: want,
  };
}

function mapJob(j: {
  metadata?: ObjectMeta;
  spec?: { completions?: number; parallelism?: number };
  status?: {
    succeeded?: number;
    failed?: number;
    active?: number;
  };
}): JobRow {
  const want = j.spec?.completions ?? j.spec?.parallelism ?? 1;
  const succeeded = j.status?.succeeded ?? 0;
  return {
    meta: j.metadata ?? {},
    completionsLabel: `${succeeded}/${want}`,
    succeeded,
    desired: want,
    active: j.status?.active ?? 0,
    failed: j.status?.failed ?? 0,
  };
}

function mapCronJob(c: {
  metadata?: ObjectMeta;
  spec?: { suspend?: boolean; schedule?: string };
  status?: { lastScheduleTime?: string };
}): CronJobRow {
  return {
    meta: c.metadata ?? {},
    schedule: c.spec?.schedule ?? '—',
    suspended: Boolean(c.spec?.suspend),
    lastSchedule: c.status?.lastScheduleTime ?? '—',
  };
}

async function loadSnapshot(
  api: KubernetesApi,
  clusterName: string,
): Promise<ClusterSnapshot> {
  const [
    podsR,
    svcR,
    nsR,
    depR,
    stsR,
    dsR,
    jobR,
    cjR,
    ingR,
    evtR,
    rolloutR,
  ] = await Promise.all([
    loadList(api, clusterName, '/api/v1/pods'),
    loadList(api, clusterName, '/api/v1/services'),
    loadList(api, clusterName, '/api/v1/namespaces'),
    loadList(api, clusterName, '/apis/apps/v1/deployments'),
    loadList(api, clusterName, '/apis/apps/v1/statefulsets'),
    loadList(api, clusterName, '/apis/apps/v1/daemonsets'),
    loadList(api, clusterName, '/apis/batch/v1/jobs'),
    loadList(api, clusterName, '/apis/batch/v1/cronjobs'),
    loadList(
      api,
      clusterName,
      '/apis/networking.k8s.io/v1/ingresses',
    ),
    loadList(api, clusterName, '/api/v1/events'),
    loadList(
      api,
      clusterName,
      '/apis/argoproj.io/v1alpha1/rollouts',
    ),
  ]);

  const hpaOut = await loadHpaRows(api, clusterName);

  const warnings: string[] = [];
  const note = (label: string, r: ListResult) => {
    if (r.warning) {
      warnings.push(`${label}: ${r.warning}`);
    }
  };
  note('Pods', podsR);
  note('Services', svcR);
  note('Namespaces', nsR);
  note('Deployments', depR);
  note('StatefulSets', stsR);
  note('DaemonSets', dsR);
  note('Jobs', jobR);
  note('CronJobs', cjR);
  note('Ingresses', ingR);
  note('Events', evtR);
  note('Rollouts', rolloutR);
  if (hpaOut.warning) {
    warnings.push(`HorizontalPodAutoscalers: ${hpaOut.warning}`);
  }

  const eventRows = (evtR.items as never[]).map(e => mapEvent(e as never));
  eventRows.sort((a, b) => b.lastTsMs - a.lastTsMs);
  const eventsCapped = eventRows.slice(0, 800);

  return {
    pods: podsR.items.map(p => mapPod(p as never)),
    services: svcR.items.map(s => mapService(s as never)),
    deployments: depR.items.map(d => mapReplicaWorkload(d as never)),
    statefulSets: stsR.items.map(s => mapReplicaWorkload(s as never)),
    daemonSets: dsR.items.map(d => mapDaemonSet(d as never)),
    jobs: jobR.items.map(j => mapJob(j as never)),
    cronJobs: cjR.items.map(c => mapCronJob(c as never)),
    rollouts: rolloutR.items.map(r => mapReplicaWorkload(r as never)),
    ingresses: ingR.items.map(i => mapIngress(i as never)),
    hpas: hpaOut.rows,
    events: eventsCapped,
    namespaces: (nsR.items as { metadata?: { name?: string } }[])
      .map(n => n.metadata?.name)
      .filter((n): n is string => Boolean(n)),
    fetchWarnings: warnings,
  };
}

function phaseChipColor(
  phase: string,
): 'default' | 'primary' | 'secondary' {
  switch (phase) {
    case 'Running':
      return 'primary';
    case 'Pending':
    case 'ContainerCreating':
      return 'secondary';
    default:
      return 'default';
  }
}

function sortRows<T>(
  rows: T[],
  sort: SortConfig,
  get: (row: T, id: string) => string | number,
): T[] {
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = get(a, sort.id);
    const vb = get(b, sort.id);
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * dir;
    }
    return (
      String(va).localeCompare(String(vb), undefined, {
        numeric: true,
        sensitivity: 'base',
      }) * dir
    );
  });
}

type SortHeadProps = {
  id: string;
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
  onSort: () => void;
  align?: 'right';
};

function SortableHead({
  id,
  label,
  active,
  direction,
  onSort,
  align,
}: SortHeadProps) {
  return (
    <TableCell align={align}>
      <TableSortLabel active={active} direction={direction} onClick={onSort}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
}

export function ClusterWideDashboard() {
  const classes = useStyles();
  const kubernetesApi = useApi(kubernetesApiRef);
  const [clusters, setClusters] = useState<{ name: string }[]>([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [clusterName, setClusterName] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | undefined>();
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(() => {
    if (typeof window === 'undefined') {
      return 25;
    }
    const v = parseInt(
      localStorage.getItem(ROWS_PER_PAGE_STORAGE_KEY) ?? '',
      10,
    );
    return [10, 25, 50, 100].includes(v) ? v : 25;
  });
  const [sortByTab, setSortByTab] = useState<Record<number, SortConfig>>({});
  const [tableFilter, setTableFilter] = useState('');
  const [autoRefreshSec, setAutoRefreshSec] = useState(0);

  const sort = useMemo(() => {
    const defaultSort: SortConfig =
      tab === 10
        ? { id: 'lastTs', desc: true }
        : { id: 'namespace', desc: false };
    return sortByTab[tab] ?? defaultSort;
  }, [sortByTab, tab]);

  const requestSort = useCallback(
    (columnId: string) => {
      setSortByTab(prev => {
        const defaultSort: SortConfig =
          tab === 10
            ? { id: 'lastTs', desc: true }
            : { id: 'namespace', desc: false };
        const cur = prev[tab] ?? defaultSort;
        const same = cur.id === columnId;
        return {
          ...prev,
          [tab]: {
            id: columnId,
            desc: same ? !cur.desc : false,
          },
        };
      });
      setPage(0);
    },
    [tab],
  );

  const loadClusters = useCallback(async () => {
    setClustersLoading(true);
    setError(undefined);
    try {
      const list = await kubernetesApi.getClusters();
      setClusters(list);
      setClusterName(prev => {
        if (prev && list.some(c => c.name === prev)) {
          return prev;
        }
        return list[0]?.name ?? '';
      });
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setClustersLoading(false);
    }
  }, [kubernetesApi]);

  const refreshSnapshot = useCallback(async () => {
    if (!clusterName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const data = await loadSnapshot(kubernetesApi, clusterName);
      setSnapshot(data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setSnapshot(undefined);
    } finally {
      setLoading(false);
    }
  }, [clusterName, kubernetesApi]);

  const refreshSnapshotRef = useRef(refreshSnapshot);
  refreshSnapshotRef.current = refreshSnapshot;

  useEffect(() => {
    try {
      localStorage.setItem(ROWS_PER_PAGE_STORAGE_KEY, String(rowsPerPage));
    } catch {
      /* ignore */
    }
  }, [rowsPerPage]);

  useEffect(() => {
    if (autoRefreshSec <= 0 || !clusterName) {
      return undefined;
    }
    const id = window.setInterval(() => {
      refreshSnapshotRef.current();
    }, autoRefreshSec * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshSec, clusterName]);

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    setPage(0);
  }, [tab]);

  useEffect(() => {
    setPage(0);
  }, [tableFilter]);

  const sortedPods = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.pods, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'phase':
          return row.phase;
        case 'restarts':
          return row.restarts;
        case 'node':
          return row.node ?? '';
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedServices = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.services, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'type':
          return row.type;
        case 'clusterIP':
          return row.clusterIP;
        case 'ports':
          return row.ports;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedDeployments = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.deployments, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'ready':
          return row.ready;
        case 'desired':
          return row.desired;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedStatefulSets = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.statefulSets, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'ready':
          return row.ready;
        case 'desired':
          return row.desired;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedDaemonSets = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.daemonSets, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'ready':
          return row.ready;
        case 'desired':
          return row.desired;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedJobs = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.jobs, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'completions':
          return row.succeeded;
        case 'active':
          return row.active;
        case 'failed':
          return row.failed;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedCronJobs = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.cronJobs, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'schedule':
          return row.schedule;
        case 'suspended':
          return row.suspended ? 1 : 0;
        case 'lastSchedule':
          return row.lastSchedule;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedRollouts = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.rollouts, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'ready':
          return row.ready;
        case 'desired':
          return row.desired;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedIngresses = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.ingresses, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'hosts':
          return row.hosts;
        case 'ingressClass':
          return row.ingressClass;
        case 'loadBalancer':
          return row.loadBalancer;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedHpas = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.hpas, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'scaleTarget':
          return row.scaleTarget;
        case 'min':
          return row.min;
        case 'max':
          return row.max;
        case 'current':
          return row.current;
        case 'desired':
          return row.desired;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const sortedEvents = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return sortRows(snapshot.events, sort, (row, id) => {
      switch (id) {
        case 'namespace':
          return row.meta.namespace ?? '';
        case 'name':
          return row.meta.name ?? '';
        case 'type':
          return row.eventType;
        case 'reason':
          return row.reason;
        case 'involved':
          return row.involved;
        case 'message':
          return row.message;
        case 'lastTs':
          return row.lastTsMs;
        default:
          return '';
      }
    });
  }, [snapshot, sort]);

  const filterLc = tableFilter.trim().toLowerCase();

  const rowMatchesFilter = useCallback(
    (parts: (string | number | undefined)[]) => {
      if (!filterLc) {
        return true;
      }
      return parts.some(p =>
        String(p ?? '')
          .toLowerCase()
          .includes(filterLc),
      );
    },
    [filterLc],
  );

  const filteredPods = useMemo(
    () =>
      sortedPods.filter(p =>
        rowMatchesFilter([
          p.meta.namespace,
          p.meta.name,
          p.phase,
          p.node,
          p.restarts,
        ]),
      ),
    [sortedPods, rowMatchesFilter],
  );

  const filteredServices = useMemo(
    () =>
      sortedServices.filter(s =>
        rowMatchesFilter([
          s.meta.namespace,
          s.meta.name,
          s.type,
          s.clusterIP,
          s.ports,
        ]),
      ),
    [sortedServices, rowMatchesFilter],
  );

  const filteredDeployments = useMemo(
    () =>
      sortedDeployments.filter(d =>
        rowMatchesFilter([
          d.meta.namespace,
          d.meta.name,
          d.readyLabel,
          d.ready,
          d.desired,
        ]),
      ),
    [sortedDeployments, rowMatchesFilter],
  );

  const filteredStatefulSets = useMemo(
    () =>
      sortedStatefulSets.filter(d =>
        rowMatchesFilter([
          d.meta.namespace,
          d.meta.name,
          d.readyLabel,
          d.ready,
          d.desired,
        ]),
      ),
    [sortedStatefulSets, rowMatchesFilter],
  );

  const filteredDaemonSets = useMemo(
    () =>
      sortedDaemonSets.filter(d =>
        rowMatchesFilter([
          d.meta.namespace,
          d.meta.name,
          d.readyLabel,
          d.ready,
          d.desired,
        ]),
      ),
    [sortedDaemonSets, rowMatchesFilter],
  );

  const filteredJobs = useMemo(
    () =>
      sortedJobs.filter(j =>
        rowMatchesFilter([
          j.meta.namespace,
          j.meta.name,
          j.completionsLabel,
          j.succeeded,
          j.active,
          j.failed,
        ]),
      ),
    [sortedJobs, rowMatchesFilter],
  );

  const filteredCronJobs = useMemo(
    () =>
      sortedCronJobs.filter(c =>
        rowMatchesFilter([
          c.meta.namespace,
          c.meta.name,
          c.schedule,
          c.suspended,
          c.lastSchedule,
        ]),
      ),
    [sortedCronJobs, rowMatchesFilter],
  );

  const filteredRollouts = useMemo(
    () =>
      sortedRollouts.filter(d =>
        rowMatchesFilter([
          d.meta.namespace,
          d.meta.name,
          d.readyLabel,
          d.ready,
          d.desired,
        ]),
      ),
    [sortedRollouts, rowMatchesFilter],
  );

  const filteredIngresses = useMemo(
    () =>
      sortedIngresses.filter(i =>
        rowMatchesFilter([
          i.meta.namespace,
          i.meta.name,
          i.hosts,
          i.ingressClass,
          i.loadBalancer,
        ]),
      ),
    [sortedIngresses, rowMatchesFilter],
  );

  const filteredHpas = useMemo(
    () =>
      sortedHpas.filter(h =>
        rowMatchesFilter([
          h.meta.namespace,
          h.meta.name,
          h.scaleTarget,
          h.min,
          h.max,
          h.current,
          h.desired,
        ]),
      ),
    [sortedHpas, rowMatchesFilter],
  );

  const filteredEvents = useMemo(
    () =>
      sortedEvents.filter(ev =>
        rowMatchesFilter([
          ev.meta.namespace,
          ev.meta.name,
          ev.eventType,
          ev.reason,
          ev.involved,
          ev.message,
          ev.lastTs,
        ]),
      ),
    [sortedEvents, rowMatchesFilter],
  );

  const exportCurrentTabCsv = useCallback(() => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const base = `kubernetes-${clusterName || 'cluster'}-${stamp}.csv`;
    switch (tab) {
      case 0:
        downloadCsv(`pods-${base}`, ['namespace', 'name', 'phase', 'restarts', 'node'], filteredPods.map(p => [p.meta.namespace ?? '', p.meta.name ?? '', p.phase, p.restarts, p.node ?? '']));
        break;
      case 1:
        downloadCsv(`services-${base}`, ['namespace', 'name', 'type', 'clusterIP', 'ports'], filteredServices.map(s => [s.meta.namespace ?? '', s.meta.name ?? '', s.type, s.clusterIP, s.ports]));
        break;
      case 2:
        downloadCsv(`deployments-${base}`, ['namespace', 'name', 'ready', 'desired'], filteredDeployments.map(d => [d.meta.namespace ?? '', d.meta.name ?? '', d.readyLabel, d.desired]));
        break;
      case 3:
        downloadCsv(`statefulsets-${base}`, ['namespace', 'name', 'ready', 'desired'], filteredStatefulSets.map(d => [d.meta.namespace ?? '', d.meta.name ?? '', d.readyLabel, d.desired]));
        break;
      case 4:
        downloadCsv(`daemonsets-${base}`, ['namespace', 'name', 'ready', 'scheduled'], filteredDaemonSets.map(d => [d.meta.namespace ?? '', d.meta.name ?? '', d.readyLabel, d.desired]));
        break;
      case 5:
        downloadCsv(`jobs-${base}`, ['namespace', 'name', 'completions', 'active', 'failed'], filteredJobs.map(j => [j.meta.namespace ?? '', j.meta.name ?? '', j.completionsLabel, j.active, j.failed]));
        break;
      case 6:
        downloadCsv(`cronjobs-${base}`, ['namespace', 'name', 'schedule', 'suspended', 'lastSchedule'], filteredCronJobs.map(c => [c.meta.namespace ?? '', c.meta.name ?? '', c.schedule, c.suspended ? 'yes' : 'no', c.lastSchedule]));
        break;
      case 7:
        downloadCsv(`rollouts-${base}`, ['namespace', 'name', 'ready', 'desired'], filteredRollouts.map(d => [d.meta.namespace ?? '', d.meta.name ?? '', d.readyLabel, d.desired]));
        break;
      case 8:
        downloadCsv(`ingresses-${base}`, ['namespace', 'name', 'hosts', 'class', 'loadBalancer'], filteredIngresses.map(i => [i.meta.namespace ?? '', i.meta.name ?? '', i.hosts, i.ingressClass, i.loadBalancer]));
        break;
      case 9:
        downloadCsv(`hpa-${base}`, ['namespace', 'name', 'target', 'min', 'max', 'current', 'desired'], filteredHpas.map(h => [h.meta.namespace ?? '', h.meta.name ?? '', h.scaleTarget, h.min, h.max, h.current, h.desired]));
        break;
      case 10:
        downloadCsv(`events-${base}`, ['namespace', 'name', 'type', 'reason', 'involved', 'lastTimestamp', 'message'], filteredEvents.map(e => [e.meta.namespace ?? '', e.meta.name ?? '', e.eventType, e.reason, e.involved, e.lastTs, e.message]));
        break;
      default:
        break;
    }
  }, [
    tab,
    clusterName,
    filteredPods,
    filteredServices,
    filteredDeployments,
    filteredStatefulSets,
    filteredDaemonSets,
    filteredJobs,
    filteredCronJobs,
    filteredRollouts,
    filteredIngresses,
    filteredHpas,
    filteredEvents,
  ]);

  const stats = useMemo(() => {
    if (!snapshot) {
      return {
        running: 0,
        pending: 0,
        otherPods: 0,
        totalRestarts: 0,
        byNs: [] as { ns: string; count: number }[],
      };
    }
    let running = 0;
    let pending = 0;
    let otherPods = 0;
    let totalRestarts = 0;
    const nsCount = new Map<string, number>();
    for (const p of snapshot.pods) {
      totalRestarts += p.restarts;
      const ns = p.meta.namespace ?? '—';
      nsCount.set(ns, (nsCount.get(ns) ?? 0) + 1);
      if (p.phase === 'Running') {
        running += 1;
      } else if (p.phase === 'Pending') {
        pending += 1;
      } else {
        otherPods += 1;
      }
    }
    const byNs = [...nsCount.entries()]
      .map(([ns, count]) => ({ ns, count }))
      .sort((a, b) => b.count - a.count);
    return { running, pending, otherPods, totalRestarts, byNs };
  }, [snapshot]);

  const maxNsCount = stats.byNs[0]?.count ?? 1;

  const currentRowsLength = useMemo(() => {
    switch (tab) {
      case 0:
        return filteredPods.length;
      case 1:
        return filteredServices.length;
      case 2:
        return filteredDeployments.length;
      case 3:
        return filteredStatefulSets.length;
      case 4:
        return filteredDaemonSets.length;
      case 5:
        return filteredJobs.length;
      case 6:
        return filteredCronJobs.length;
      case 7:
        return filteredRollouts.length;
      case 8:
        return filteredIngresses.length;
      case 9:
        return filteredHpas.length;
      case 10:
        return filteredEvents.length;
      default:
        return 0;
    }
  }, [
    tab,
    filteredPods,
    filteredServices,
    filteredDeployments,
    filteredStatefulSets,
    filteredDaemonSets,
    filteredJobs,
    filteredCronJobs,
    filteredRollouts,
    filteredIngresses,
    filteredHpas,
    filteredEvents,
  ]);

  const paginatedSlice = useCallback(
    <T,>(sorted: T[]) =>
      sorted.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [page, rowsPerPage],
  );

  if (clustersLoading) {
    return (
      <Box display="flex" justifyContent="center" padding={4}>
        <Progress />
      </Box>
    );
  }

  if (!clustersLoading && clusters.length === 0 && !error) {
    return (
      <WarningPanel title="No Kubernetes clusters" severity="info">
        Configure <code>kubernetes.clusterLocatorMethods</code> in{' '}
        <code>app-config.yaml</code> so Backstage can reach your API server.
      </WarningPanel>
    );
  }

  const dir = sort.desc ? 'desc' : 'asc';

  return (
    <>
      <Box className={classes.hubbleStrip}>
        <Typography variant="subtitle1" component="h2">
          Cluster-wide overview
        </Typography>
        <Typography variant="body2">
          Live workload and service inventory through the Kubernetes plugin proxy
          (similar in spirit to a Hubble “whole cluster” view — without Cilium
          flow telemetry).
        </Typography>
      </Box>

      <WarningPanel title="Permissions" severity="info">
        This page calls the{' '}
        <a href="https://backstage.io/docs/features/kubernetes/configuration">
          Kubernetes plugin proxy
        </a>
        . Users need the <code>kubernetes.proxy</code> permission (often allowed
        by default in dev). Per-component views on the catalog Kubernetes tab
        use separate resource rules.
      </WarningPanel>

      <Grid container spacing={2} alignItems="center" style={{ marginTop: 8, marginBottom: 16 }}>
        <Grid item>
          <FormControl variant="outlined" style={{ minWidth: 220 }}>
            <InputLabel id="cluster-select-label">Cluster</InputLabel>
            <Select
              labelId="cluster-select-label"
              label="Cluster"
              value={clusterName}
              onChange={e => setClusterName(String(e.target.value))}
              disabled={clusters.length === 0}
            >
              {clusters.map(c => (
                <MenuItem key={c.name} value={c.name}>
                  {c.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        <Grid item>
          <Button
            variant="outlined"
            color="primary"
            startIcon={<RefreshIcon />}
            onClick={() => refreshSnapshot()}
            disabled={!clusterName || loading}
          >
            Refresh
          </Button>
        </Grid>
        <Grid item>
          <Button variant="text" color="primary" component={Link} to="/catalog">
            Open catalog
          </Button>
        </Grid>
      </Grid>

      {loading && snapshot && <LinearProgress />}
      {error && <ResponseErrorPanel error={error} />}
      {!loading && !error && snapshot && (
        <>
          <div className={classes.statGrid}>
            <InfoCard title="Pods (Running)">
              <Typography variant="h3">{stats.running}</Typography>
            </InfoCard>
            <InfoCard title="Pods (Pending)">
              <Typography variant="h3">{stats.pending}</Typography>
            </InfoCard>
            <InfoCard title="Pods (other phases)">
              <Typography variant="h3">{stats.otherPods}</Typography>
            </InfoCard>
            <InfoCard title="Namespaces">
              <Typography variant="h3">{snapshot.namespaces.length}</Typography>
            </InfoCard>
            <InfoCard title="Services">
              <Typography variant="h3">{snapshot.services.length}</Typography>
            </InfoCard>
            <InfoCard title="Deployments">
              <Typography variant="h3">{snapshot.deployments.length}</Typography>
            </InfoCard>
            <InfoCard title="StatefulSets">
              <Typography variant="h3">{snapshot.statefulSets.length}</Typography>
            </InfoCard>
            <InfoCard title="DaemonSets">
              <Typography variant="h3">{snapshot.daemonSets.length}</Typography>
            </InfoCard>
            <InfoCard title="Jobs">
              <Typography variant="h3">{snapshot.jobs.length}</Typography>
            </InfoCard>
            <InfoCard title="CronJobs">
              <Typography variant="h3">{snapshot.cronJobs.length}</Typography>
            </InfoCard>
            <InfoCard title="Rollouts (Argo)">
              <Typography variant="h3">{snapshot.rollouts.length}</Typography>
            </InfoCard>
            <InfoCard title="Ingresses">
              <Typography variant="h3">{snapshot.ingresses.length}</Typography>
            </InfoCard>
            <InfoCard title="HPAs">
              <Typography variant="h3">{snapshot.hpas.length}</Typography>
            </InfoCard>
            <InfoCard title="Events (recent, capped)">
              <Typography variant="h3">{snapshot.events.length}</Typography>
              <Typography variant="caption" color="textSecondary">
                Newest 800 from list
              </Typography>
            </InfoCard>
            <InfoCard title="Container restarts (sum)">
              <Typography variant="h3">{stats.totalRestarts}</Typography>
            </InfoCard>
          </div>

          {snapshot.fetchWarnings.length > 0 ? (
            <WarningPanel title="Some resource lists failed to load" severity="warning">
              <Box component="ul" margin={0} paddingLeft={2.5}>
                {snapshot.fetchWarnings.map((w, i) => (
                  <li key={i}>
                    <Typography variant="body2">{w}</Typography>
                  </li>
                ))}
              </Box>
            </WarningPanel>
          ) : null}

          <InfoCard title="Pods per namespace" subheader="Top namespaces by pod count">
            <Box>
              {stats.byNs.slice(0, 12).map(({ ns, count }) => (
                <Box key={ns} marginBottom={1.5}>
                  <Box display="flex" justifyContent="space-between">
                    <Typography variant="body2">{ns}</Typography>
                    <Typography variant="body2" color="textSecondary">
                      {count}
                    </Typography>
                  </Box>
                  <div className={classes.nsBarTrack}>
                    <div
                      className={classes.nsBarFill}
                      style={{ width: `${(count / maxNsCount) * 100}%` }}
                    />
                  </div>
                </Box>
              ))}
            </Box>
          </InfoCard>

          <Box marginTop={3}>
            <Box className={classes.tableToolbar}>
              <TextField
                size="small"
                variant="outlined"
                label="Filter current tab"
                placeholder="Matches any column text"
                value={tableFilter}
                onChange={e => setTableFilter(e.target.value)}
                style={{ minWidth: 280 }}
              />
              <FormControl variant="outlined" size="small" style={{ minWidth: 200 }}>
                <InputLabel id="auto-refresh-label">Auto-refresh</InputLabel>
                <Select
                  labelId="auto-refresh-label"
                  label="Auto-refresh"
                  value={autoRefreshSec}
                  onChange={e => setAutoRefreshSec(Number(e.target.value))}
                >
                  <MenuItem value={0}>Off</MenuItem>
                  <MenuItem value={30}>Every 30s</MenuItem>
                  <MenuItem value={60}>Every 60s</MenuItem>
                  <MenuItem value={120}>Every 2 min</MenuItem>
                </Select>
              </FormControl>
              <Button
                variant="outlined"
                color="primary"
                startIcon={<GetAppIcon />}
                onClick={exportCurrentTabCsv}
                disabled={currentRowsLength === 0}
              >
                Download CSV
              </Button>
              {filterLc ? (
                <Typography variant="body2" color="textSecondary">
                  Showing {currentRowsLength} row
                  {currentRowsLength === 1 ? '' : 's'} (filter active)
                </Typography>
              ) : null}
            </Box>
            <Tabs
              value={tab}
              onChange={(_, v) => setTab(v)}
              indicatorColor="primary"
              textColor="primary"
              variant="scrollable"
              scrollButtons="auto"
            >
              <Tab label={`Pods (${snapshot.pods.length})`} />
              <Tab label={`Services (${snapshot.services.length})`} />
              <Tab label={`Deployments (${snapshot.deployments.length})`} />
              <Tab label={`StatefulSets (${snapshot.statefulSets.length})`} />
              <Tab label={`DaemonSets (${snapshot.daemonSets.length})`} />
              <Tab label={`Jobs (${snapshot.jobs.length})`} />
              <Tab label={`CronJobs (${snapshot.cronJobs.length})`} />
              <Tab label={`Rollouts (${snapshot.rollouts.length})`} />
              <Tab label={`Ingresses (${snapshot.ingresses.length})`} />
              <Tab label={`HPAs (${snapshot.hpas.length})`} />
              <Tab label={`Events (${snapshot.events.length})`} />
            </Tabs>

            {tab === 0 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="Name"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="phase"
                          label="Phase"
                          active={sort.id === 'phase'}
                          direction={dir}
                          onSort={() => requestSort('phase')}
                        />
                        <SortableHead
                          id="restarts"
                          label="Restarts"
                          active={sort.id === 'restarts'}
                          direction={dir}
                          onSort={() => requestSort('restarts')}
                          align="right"
                        />
                        <SortableHead
                          id="node"
                          label="Node"
                          active={sort.id === 'node'}
                          direction={dir}
                          onSort={() => requestSort('node')}
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredPods).map(p => (
                        <TableRow key={`${p.meta.namespace}/${p.meta.name}`}>
                          <TableCell>{p.meta.namespace}</TableCell>
                          <TableCell>{p.meta.name}</TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={p.phase}
                              color={phaseChipColor(p.phase)}
                            />
                          </TableCell>
                          <TableCell align="right">{p.restarts}</TableCell>
                          <TableCell>{p.node ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 1 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="Name"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="type"
                          label="Type"
                          active={sort.id === 'type'}
                          direction={dir}
                          onSort={() => requestSort('type')}
                        />
                        <SortableHead
                          id="clusterIP"
                          label="Cluster IP"
                          active={sort.id === 'clusterIP'}
                          direction={dir}
                          onSort={() => requestSort('clusterIP')}
                        />
                        <SortableHead
                          id="ports"
                          label="Ports"
                          active={sort.id === 'ports'}
                          direction={dir}
                          onSort={() => requestSort('ports')}
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredServices).map(s => (
                        <TableRow key={`${s.meta.namespace}/${s.meta.name}`}>
                          <TableCell>{s.meta.namespace}</TableCell>
                          <TableCell>{s.meta.name}</TableCell>
                          <TableCell>{s.type}</TableCell>
                          <TableCell>{s.clusterIP}</TableCell>
                          <TableCell>{s.ports}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 2 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="Deployment"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="ready"
                          label="Ready"
                          active={sort.id === 'ready'}
                          direction={dir}
                          onSort={() => requestSort('ready')}
                          align="right"
                        />
                        <SortableHead
                          id="desired"
                          label="Desired"
                          active={sort.id === 'desired'}
                          direction={dir}
                          onSort={() => requestSort('desired')}
                          align="right"
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredDeployments).map(d => (
                        <TableRow key={`${d.meta.namespace}/${d.meta.name}`}>
                          <TableCell>{d.meta.namespace}</TableCell>
                          <TableCell>{d.meta.name}</TableCell>
                          <TableCell align="right">{d.readyLabel}</TableCell>
                          <TableCell align="right">{d.desired}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 3 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="StatefulSet"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="ready"
                          label="Ready"
                          active={sort.id === 'ready'}
                          direction={dir}
                          onSort={() => requestSort('ready')}
                          align="right"
                        />
                        <SortableHead
                          id="desired"
                          label="Desired"
                          active={sort.id === 'desired'}
                          direction={dir}
                          onSort={() => requestSort('desired')}
                          align="right"
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredStatefulSets).map(d => (
                        <TableRow key={`${d.meta.namespace}/${d.meta.name}`}>
                          <TableCell>{d.meta.namespace}</TableCell>
                          <TableCell>{d.meta.name}</TableCell>
                          <TableCell align="right">{d.readyLabel}</TableCell>
                          <TableCell align="right">{d.desired}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 4 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="DaemonSet"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="ready"
                          label="Ready"
                          active={sort.id === 'ready'}
                          direction={dir}
                          onSort={() => requestSort('ready')}
                          align="right"
                        />
                        <SortableHead
                          id="desired"
                          label="Scheduled"
                          active={sort.id === 'desired'}
                          direction={dir}
                          onSort={() => requestSort('desired')}
                          align="right"
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredDaemonSets).map(d => (
                        <TableRow key={`${d.meta.namespace}/${d.meta.name}`}>
                          <TableCell>{d.meta.namespace}</TableCell>
                          <TableCell>{d.meta.name}</TableCell>
                          <TableCell align="right">{d.readyLabel}</TableCell>
                          <TableCell align="right">{d.desired}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 5 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="Job"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="completions"
                          label="Succeeded / target"
                          active={sort.id === 'completions'}
                          direction={dir}
                          onSort={() => requestSort('completions')}
                          align="right"
                        />
                        <SortableHead
                          id="active"
                          label="Active"
                          active={sort.id === 'active'}
                          direction={dir}
                          onSort={() => requestSort('active')}
                          align="right"
                        />
                        <SortableHead
                          id="failed"
                          label="Failed"
                          active={sort.id === 'failed'}
                          direction={dir}
                          onSort={() => requestSort('failed')}
                          align="right"
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredJobs).map(j => (
                        <TableRow key={`${j.meta.namespace}/${j.meta.name}`}>
                          <TableCell>{j.meta.namespace}</TableCell>
                          <TableCell>{j.meta.name}</TableCell>
                          <TableCell align="right">{j.completionsLabel}</TableCell>
                          <TableCell align="right">{j.active}</TableCell>
                          <TableCell align="right">{j.failed}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 6 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="CronJob"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="schedule"
                          label="Schedule"
                          active={sort.id === 'schedule'}
                          direction={dir}
                          onSort={() => requestSort('schedule')}
                        />
                        <SortableHead
                          id="suspended"
                          label="Suspended"
                          active={sort.id === 'suspended'}
                          direction={dir}
                          onSort={() => requestSort('suspended')}
                        />
                        <SortableHead
                          id="lastSchedule"
                          label="Last schedule"
                          active={sort.id === 'lastSchedule'}
                          direction={dir}
                          onSort={() => requestSort('lastSchedule')}
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredCronJobs).map(c => (
                        <TableRow key={`${c.meta.namespace}/${c.meta.name}`}>
                          <TableCell>{c.meta.namespace}</TableCell>
                          <TableCell>{c.meta.name}</TableCell>
                          <TableCell>
                            <Typography variant="body2" component="span" noWrap>
                              {c.schedule}
                            </Typography>
                          </TableCell>
                          <TableCell>{c.suspended ? 'Yes' : 'No'}</TableCell>
                          <TableCell>{c.lastSchedule}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 7 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="Rollout"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="ready"
                          label="Ready"
                          active={sort.id === 'ready'}
                          direction={dir}
                          onSort={() => requestSort('ready')}
                          align="right"
                        />
                        <SortableHead
                          id="desired"
                          label="Desired"
                          active={sort.id === 'desired'}
                          direction={dir}
                          onSort={() => requestSort('desired')}
                          align="right"
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredRollouts).map(d => (
                        <TableRow key={`${d.meta.namespace}/${d.meta.name}`}>
                          <TableCell>{d.meta.namespace}</TableCell>
                          <TableCell>{d.meta.name}</TableCell>
                          <TableCell align="right">{d.readyLabel}</TableCell>
                          <TableCell align="right">{d.desired}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 8 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="Ingress"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="hosts"
                          label="Hosts"
                          active={sort.id === 'hosts'}
                          direction={dir}
                          onSort={() => requestSort('hosts')}
                        />
                        <SortableHead
                          id="ingressClass"
                          label="Class"
                          active={sort.id === 'ingressClass'}
                          direction={dir}
                          onSort={() => requestSort('ingressClass')}
                        />
                        <SortableHead
                          id="loadBalancer"
                          label="Load balancer"
                          active={sort.id === 'loadBalancer'}
                          direction={dir}
                          onSort={() => requestSort('loadBalancer')}
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredIngresses).map(i => (
                        <TableRow key={`${i.meta.namespace}/${i.meta.name}`}>
                          <TableCell>{i.meta.namespace}</TableCell>
                          <TableCell>{i.meta.name}</TableCell>
                          <TableCell>
                            <Typography variant="body2" noWrap title={i.hosts}>
                              {i.hosts}
                            </Typography>
                          </TableCell>
                          <TableCell>{i.ingressClass}</TableCell>
                          <TableCell>
                            <Typography variant="body2" noWrap title={i.loadBalancer}>
                              {i.loadBalancer}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 9 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="name"
                          label="HPA"
                          active={sort.id === 'name'}
                          direction={dir}
                          onSort={() => requestSort('name')}
                        />
                        <SortableHead
                          id="scaleTarget"
                          label="Scale target"
                          active={sort.id === 'scaleTarget'}
                          direction={dir}
                          onSort={() => requestSort('scaleTarget')}
                        />
                        <SortableHead
                          id="min"
                          label="Min"
                          active={sort.id === 'min'}
                          direction={dir}
                          onSort={() => requestSort('min')}
                          align="right"
                        />
                        <SortableHead
                          id="max"
                          label="Max"
                          active={sort.id === 'max'}
                          direction={dir}
                          onSort={() => requestSort('max')}
                          align="right"
                        />
                        <SortableHead
                          id="current"
                          label="Current"
                          active={sort.id === 'current'}
                          direction={dir}
                          onSort={() => requestSort('current')}
                          align="right"
                        />
                        <SortableHead
                          id="desired"
                          label="Desired"
                          active={sort.id === 'desired'}
                          direction={dir}
                          onSort={() => requestSort('desired')}
                          align="right"
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredHpas).map(h => (
                        <TableRow key={`${h.meta.namespace}/${h.meta.name}`}>
                          <TableCell>{h.meta.namespace}</TableCell>
                          <TableCell>{h.meta.name}</TableCell>
                          <TableCell>{h.scaleTarget}</TableCell>
                          <TableCell align="right">{h.min}</TableCell>
                          <TableCell align="right">{h.max}</TableCell>
                          <TableCell align="right">{h.current}</TableCell>
                          <TableCell align="right">{h.desired}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}

            {tab === 10 && (
              <Paper>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <SortableHead
                          id="namespace"
                          label="Namespace"
                          active={sort.id === 'namespace'}
                          direction={dir}
                          onSort={() => requestSort('namespace')}
                        />
                        <SortableHead
                          id="type"
                          label="Type"
                          active={sort.id === 'type'}
                          direction={dir}
                          onSort={() => requestSort('type')}
                        />
                        <SortableHead
                          id="reason"
                          label="Reason"
                          active={sort.id === 'reason'}
                          direction={dir}
                          onSort={() => requestSort('reason')}
                        />
                        <SortableHead
                          id="involved"
                          label="Involved"
                          active={sort.id === 'involved'}
                          direction={dir}
                          onSort={() => requestSort('involved')}
                        />
                        <SortableHead
                          id="lastTs"
                          label="Last seen"
                          active={sort.id === 'lastTs'}
                          direction={dir}
                          onSort={() => requestSort('lastTs')}
                        />
                        <SortableHead
                          id="message"
                          label="Message"
                          active={sort.id === 'message'}
                          direction={dir}
                          onSort={() => requestSort('message')}
                        />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paginatedSlice(filteredEvents).map((e, rowIdx) => (
                        <TableRow
                          key={
                            e.uid ??
                            `${e.meta.namespace}-${e.meta.name}-${e.lastTsMs}-${rowIdx}`
                          }
                        >
                          <TableCell>{e.meta.namespace || '—'}</TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={e.eventType}
                              color={
                                e.eventType === 'Warning' ? 'secondary' : 'default'
                              }
                            />
                          </TableCell>
                          <TableCell>{e.reason}</TableCell>
                          <TableCell>
                            <Typography variant="body2" noWrap title={e.involved}>
                              {e.involved}
                            </Typography>
                          </TableCell>
                          <TableCell>{e.lastTs}</TableCell>
                          <TableCell>
                            <Typography variant="body2" noWrap title={e.message}>
                              {e.message}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <TablePagination
                  component="div"
                  count={currentRowsLength}
                  page={page}
                  onPageChange={(_, p) => setPage(p)}
                  rowsPerPage={rowsPerPage}
                  onRowsPerPageChange={e => {
                    setRowsPerPage(parseInt(e.target.value, 10));
                    setPage(0);
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                />
              </Paper>
            )}
          </Box>
        </>
      )}
      {loading && !snapshot && clusterName ? (
        <Box marginY={4} display="flex" justifyContent="center">
          <Progress />
        </Box>
      ) : null}
    </>
  );
}
