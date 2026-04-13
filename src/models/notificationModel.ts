export interface INotification {
  id?: string;
  type: string;
  title: string;
  message: string;
  leadId?: string;
  read: boolean;
  createdAt: number;
  readAt?: number | null;
}
