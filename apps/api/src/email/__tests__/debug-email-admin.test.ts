import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EmailAdminService } from '../email-admin.service';
import { InMemoryEmailPrisma } from './email-support';
import { TOKEN } from './email-support';

test('debug wire output', async () => {
  const prisma = new InMemoryEmailPrisma();
  const audit: any[] = [];
  const service = new EmailAdminService(prisma as any, { record: async (e: any) => void audit.push(e) } as any);
  const ago = (ms: number) => new Date(Date.now() - ms);
  prisma.seed({ id: 'row1', toEmail: 'Jane.Doe@Customer.Example', template: 'password_reset', status: 'FAILED', attempts: 3, lastError: 'HTTP 500 token=' + TOKEN + ' jane.doe@customer.example', createdAt: ago(5000) });
  prisma.seed({ id: 'row2', toEmail: 'x@y.example', template: 'order_shipped', status: 'SENT', attempts: 1, lastError: null, sentAt: ago(1000), createdAt: ago(4000), data: { orderId: 'o1', carrier: 'UPS', trackingNumber: '1Z', trackingUrl: null } });
  const page = await service.list({});
  const wire = JSON.stringify(page);
  console.log('DEBUG WIRE:', wire);
  console.log('DEBUG contains TOKEN:', wire.includes(TOKEN));
  console.log('DEBUG row1 lastError:', page.items.find((i:any) => i.id === 'row1')?.lastError);
});
