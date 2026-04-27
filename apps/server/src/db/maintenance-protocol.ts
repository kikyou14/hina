export type MaintenanceRequest =
  | { op: "vacuum" }
  | { op: "optimize" }
  | { op: "vacuum_into"; targetPath: string };

export type MaintenanceMessage =
  | { kind: "init"; dbPath: string }
  | { kind: "call"; id: number; request: MaintenanceRequest };

export type MaintenanceResponse =
  | { kind: "ready"; ok: true }
  | { kind: "ready"; ok: false; error: string }
  | { kind: "result"; id: number; ok: true; durationMs: number }
  | { kind: "result"; id: number; ok: false; error: string };
