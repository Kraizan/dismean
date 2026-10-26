/** Sole builder for job file paths (ITD-028). See docs/code-map.md · LLD §11. */
export function inputPrefix(jobId: string): string {
  return `jobs/${jobId}/inputs/`;
}

export function inputPath(jobId: string, index: number): string {
  return `${inputPrefix(jobId)}${String(index).padStart(6, "0")}.npy`;
}

export function partialPath(jobId: string, taskId: string): string {
  return `jobs/${jobId}/partials/${taskId}.npy`;
}

export function resultPaths(jobId: string): { npy: string; csv: string } {
  return {
    npy: `jobs/${jobId}/result.npy`,
    csv: `jobs/${jobId}/result.csv`,
  };
}

export function jobDirRelative(jobId: string): string {
  return `jobs/${jobId}`;
}
