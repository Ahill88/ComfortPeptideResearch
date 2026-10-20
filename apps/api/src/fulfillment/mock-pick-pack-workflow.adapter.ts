import { type PackedParcel, type PickPackWorkflow, type PickTask } from './fulfillment-workflow.types';

type TaskState = PickTask & { picked: boolean };

export class MockPickPackWorkflow implements PickPackWorkflow {
  private nextTask = 1;
  private nextParcel = 1;
  private readonly tasks = new Map<string, TaskState>();

  async createPickTask(orderId: string, items: PickTask['items']): Promise<PickTask> {
    if (!orderId || items.length === 0) throw new TypeError('orderId and at least one item are required');
    const task: TaskState = { taskId: `pick_${this.nextTask++}`, orderId, items: [...items], picked: false };
    this.tasks.set(task.taskId, task);
    return this.toPickTask(task);
  }

  async confirmPicked(taskId: string): Promise<PickTask> {
    const task = this.requireTask(taskId);
    task.picked = true;
    return this.toPickTask(task);
  }

  async pack(taskId: string, weightGrams: number): Promise<PackedParcel> {
    const task = this.requireTask(taskId);
    if (!task.picked) throw new Error(`Pick task ${taskId} has not been confirmed`);
    if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) throw new TypeError('weightGrams must be a positive integer');
    return { parcelId: `parcel_${this.nextParcel++}`, orderId: task.orderId, weightGrams };
  }

  private requireTask(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown pick task ${taskId}`);
    return task;
  }

  private toPickTask(task: TaskState): PickTask {
    return { taskId: task.taskId, orderId: task.orderId, items: [...task.items] };
  }
}
