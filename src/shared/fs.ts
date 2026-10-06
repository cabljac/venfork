import { access } from 'node:fs/promises';

/** Resolves true when `filePath` is accessible, false otherwise. */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
