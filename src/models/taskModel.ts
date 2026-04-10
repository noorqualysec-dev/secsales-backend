// export interface ITask {
//     id?: string;
//     subject: string;
//     description?: string;
//     dueDate: number; // Timestamp
//     status: "Waiting on someone" | "Pending" | "In Progress" | "Completed" | "Deferred";
//     priority: "Low" | "Medium" | "High" | "Urgent";
//     assignedTo: string; // User ID
//     assignedBy?: string;
//     createdBy: string;
//     leadId?: string | null; // Optional reference to a lead
//     createdAt: number;
//     updatedAt: number;
// }

// export const TASK_STATUSES = ["Waiting on someone", "Pending", "In Progress", "Completed", "Deferred"] as const;
// export const TASK_PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const;
export type TaskStatus =
  | "Pending"
  | "In Progress"
  | "Waiting on someone"
  | "Deferred"
  | "Completed";

export type TaskPriority = "Low" | "Medium" | "High";

export type TaskSource = "self" | "admin" | "system";

export interface ITask {
  id?: string;

  subject: string;
  description?: string;

  dueDate: number; // timestamp
  status: TaskStatus;
  priority: TaskPriority;

  assignedTo: string; // sales rep user id
  assignedBy: string; // who assigned the task
  createdBy: string; // who created it

  source: TaskSource; // self/admin/system

  leadId?: string;

  isRead?: boolean; // useful for assigned task visibility

  completedAt?: number;
  completedBy?: string;
  completionRemark?: string;

  createdAt: number;
  updatedAt: number;
}

export const TASK_STATUSES = [
  "Pending",
  "In Progress",
  "Waiting on someone",
  "Deferred",
  "Completed",
] as const;

export const TASK_PRIORITIES = ["Low", "Medium", "High"] as const;

export const TASK_SOURCES = ["self", "admin", "system"] as const;