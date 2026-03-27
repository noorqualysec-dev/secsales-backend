export interface IUser {
    id?: string;
    name: string;
    email: string;
    role: "admin" | "sales_rep" | "manager";
    isActive: boolean;
    createdAt: number;
    updatedAt: number;
}

export const USER_ROLES = ["admin", "sales_rep", "manager"] as const;
