import { buildCaseFile } from '@/lib/replay/caseFile';
import { CaseStage } from './CaseStage';

export function CaseFile() {
  return <CaseStage data={buildCaseFile()} />;
}
