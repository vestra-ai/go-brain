/** Lane C (P4) owns this file. P1 creates it so Brain compiles; P4 implements Tasks and sets brain.tasks. */
export interface Tasks {
  start(tripId: string, brief: { goal: string; returns: unknown; context: Record<string, unknown> }): Promise<{ taskId: string; cardId: string }>;
  message(taskId: string, text: string): Promise<void>;
  stop(taskId: string): Promise<void>;
  running(tripId: string): Promise<Array<{ id: string; brief: string; state: string }>>;
  /** A person answered a job's hand-off (a code, a choice) or it expired. */
  handoff(taskId: string, outcome: { answer: string } | { expired: true }): Promise<void>;
}
