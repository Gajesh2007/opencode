// Collects what CLI code writes to stdout and stderr, keeping it out of the test output until `restore`.
export function captureOutput() {
  const output = { stdout: "", stderr: "" }
  // oxlint-disable-next-line typescript-eslint/unbound-method -- restored by `restore` after temporarily capturing.
  const original = { stdout: process.stdout.write, stderr: process.stderr.write }
  process.stdout.write = ((chunk) => {
    output.stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk) => {
    output.stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  return {
    output,
    restore: () => {
      process.stdout.write = original.stdout
      process.stderr.write = original.stderr
    },
  }
}
