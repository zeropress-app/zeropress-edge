import { getLogErrorMessage, logWarn } from './log';

export async function runInBackground(
  ctx: ExecutionContext | undefined,
  task: Promise<unknown>,
  label: string,
): Promise<void> {
  const guardedTask = task.catch((error) => {
    logWarn('Background task failed', {
      task: label,
      errorMessage: getLogErrorMessage(error),
    });
  });

  if (ctx) {
    ctx.waitUntil(guardedTask);
    return;
  }

  await guardedTask;
}
