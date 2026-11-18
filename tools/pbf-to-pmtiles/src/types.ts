export type PipelineStepId =
  | 'download_pbf'
  | 'download_enrichment'
  | 'inject_enrichment'
  | 'convert_pmtiles'
  | 'validate_pmtiles'
  | 'upload_firebase';

export type StepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export type LogLevel = 'info' | 'warn' | 'error';

export interface CountrySpec {
  key: string;
  name: string;
  outputPrefix: string;
  pbfUrl: string;
  md5Url?: string;
  bbox?: [number, number, number, number];
}

export interface PipelineStepState {
  id: PipelineStepId;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  detail?: string;
}

export interface ValidationSummary {
  pmtilesPath: string;
  fileSizeBytes: number;
  minZoom: number;
  maxZoom: number;
  numAddressedTiles: number;
  numTileEntries: number;
  layersFound: string[];
  parkFeatureCount: number;
  transportationFeatureCount: number;
  searchIndexPath?: string;
  searchIndexBytes?: number;
}

export interface RunOptions {
  countryKey: string;
  customPbfUrl?: string;
  customOutputPrefix?: string;
  forceDownload?: boolean;
  includeFirestore?: boolean;
  tilemakerMode?: 'auto' | 'native' | 'wsl';
  rebuildSearchIndex?: boolean;
  dryRun?: boolean;
  fromStep?: PipelineStepId;
}

export interface PipelineRunRecord {
  id: string;
  createdAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  countryKey: string;
  outputPrefix: string;
  dryRun: boolean;
  options: RunOptions;
  steps: PipelineStepState[];
  validation?: ValidationSummary;
  deployedUrl?: string;
  error?: string;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  step?: PipelineStepId;
  message: string;
}

export interface EnrichmentRecord {
  source: 'hosting' | 'firestore';
  id: string;
  name: string;
  numbers: string[];
  wayIds: string[];
  colour?: string;
  osmcSymbol?: string;
  description?: string;
  hazard?: string;
  activities?: string;
  lon?: number;
  lat?: number;
}

export interface ResolvedEnrichmentBundle {
  generatedAt: string;
  countryKey: string;
  totalRecords: number;
  hostingRecords: number;
  firestoreRecords: number;
  byWayId: Record<string, EnrichmentRecord>;
  byRef: Record<string, EnrichmentRecord>;
  records: EnrichmentRecord[];
}
