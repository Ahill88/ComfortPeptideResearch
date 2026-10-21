'use server';

import { revalidatePath } from 'next/cache';
import type { CreatedAdmin } from '../../lib/types';
import { actionApi, guardAction } from '../../lib/server/action-guard';

export interface CreateAdminState { error?: string; created?: CreatedAdmin; values?: { email: string; name: string; role: string } }
export interface DeactivateResult { ok: boolean; message: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createAdmin(_previous: CreateAdminState, formData: FormData): Promise<CreateAdminState> {
  const guard = await guardAction('OWNER');
  const email = String(formData.get('email') ?? '').trim().slice(0, 254);
  const name = String(formData.get('name') ?? '').trim().slice(0, 120);
  const role = String(formData.get('role') ?? 'STAFF');
  const values = { email, name, role };
  if (!guard.ok) return { error: guard.message, values };
  if (!EMAIL.test(email)) return { error: 'Enter a valid email address.', values };
  if (!name) return { error: 'Enter a name.', values };
  if (role !== 'OWNER' && role !== 'STAFF') return { error: 'Choose a role.', values };
  const result = await actionApi<CreatedAdmin>('/admin/users', { method: 'POST', body: { email, name, role } });
  if (!result.ok) return { error: result.message, values };
  revalidatePath('/team');
  return { created: result.data };
}

export async function deactivateAdmin(id: string): Promise<DeactivateResult> {
  const guard = await guardAction('OWNER');
  if (!guard.ok) return { ok: false, message: guard.message };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, message: 'Invalid user.' };
  if (id === guard.auth.admin.id) return { ok: false, message: 'You cannot deactivate your own account.' };
  const result = await actionApi<void>(`/admin/users/${encodeURIComponent(id)}/deactivate`, { method: 'POST', body: {} });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/team');
  return { ok: true, message: 'Admin deactivated.' };
}
