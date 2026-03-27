export interface ITask {
    id?: string;
    subject: string;
    dueDate: number; // Timestamp
    status: "Waiting on someone" | "Pending" | "Completed" | "Deferred";
    priority: "Low" | "Medium" | "High";
    assignedTo: string; // User ID
    leadId?: string; // Optional reference to a lead
    createdAt: number;
    updatedAt: number;
}

export const TASK_STATUSES = ["Waiting on someone", "Pending", "Completed", "Deferred"] as const;
