export type PickTask = Readonly<{
  taskId: string;
  orderId: string;
  items: readonly Readonly<{ sku: string; quantity: number; lotCode: string }> [];
}>;

export type PackedParcel = Readonly<{
  parcelId: string;
  orderId: string;
  weightGrams: number;
}>;

export interface PickPackWorkflow {
  createPickTask(orderId: string, items: PickTask['items']): Promise<PickTask>;
  confirmPicked(taskId: string): Promise<PickTask>;
  pack(taskId: string, weightGrams: number): Promise<PackedParcel>;
}
