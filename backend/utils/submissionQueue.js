/**
 * Per-team ordered submission queue.
 */
export class SubmissionQueue {
  constructor() {
    /** @type {Map<string, Promise<any>>} teamId -> tail of that team's chain */
    this.tails = new Map();
  }

  /**
   * Run `taskFn` for `teamId` only after every previously enqueued task
   * for that same team has finished (success or failure). Returns a
   * promise that resolves/rejects with taskFn's own outcome.
   *
   * @param {string} teamId
   * @param {() => Promise<any>} taskFn
   */
  enqueue(teamId, taskFn) {
    const previousTail = this.tails.get(teamId) || Promise.resolve();

    const result = previousTail.catch(() => {}).then(() => taskFn());
    const tailPromise = result.catch(() => {}).finally(() => {
      if (this.tails.get(teamId) === tailPromise) {
        this.tails.delete(teamId);
      }
    });
    this.tails.set(teamId, tailPromise);

    return result;
  }

  /** How many teams currently have an in-flight/queued task (for diagnostics/tests) */
  get activeTeamCount() {
    return this.tails.size;
  }
}

const submissionQueue = new SubmissionQueue();
export default submissionQueue;
