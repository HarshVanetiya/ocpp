import bcrypt from 'bcryptjs';
import type { CountryCode } from 'libphonenumber-js';
import { prisma } from '../src/client';
import { normalizePhone } from '../src/phone';

async function main() {
    const hash = await bcrypt.hash('admin123', 10);

    await prisma.adminUser.upsert({
        where: { email: 'super@ev.local' },
        update: {},
        create: {
            email: 'super@ev.local',
            passwordHash: hash,
            role: 'SUPER_ADMIN',
        },
    });

    const tenant = await prisma.tenant.upsert({
        where: { slug: 'tata-fleet' },
        update: {},
        create: { name: 'Tata Fleet', slug: 'tata-fleet', country: 'IN' },
    });

    await prisma.adminUser.upsert({
        where: { email: 'admin@tata.local' },
        update: {},
        create: {
            email: 'admin@tata.local',
            passwordHash: hash,
            role: 'TENANT_ADMIN',
            tenantId: tenant.id,
        },
    });

    const cp = await prisma.chargePoint.upsert({
        where: { ocppId: 'CP_TEST01' },
        update: {},
        create: {
            ocppId: 'CP_TEST01',
            name: 'Depot Bay 1',
            tenantId: tenant.id,
            allowedModes: ['FLEET', 'PUBLIC'],
            connectors: { create: [{ connectorId: 1 }, { connectorId: 2 }] },
        },
    });

    for (const [mode, price] of [
        ['FLEET', 0],
        ['PUBLIC', 18],
    ] as const) {
        await prisma.chargerTariffRule.upsert({
            where: { chargePointId_mode: { chargePointId: cp.id, mode } },
            update: {},
            create: {
                chargePointId: cp.id,
                tenantId: tenant.id,
                mode,
                pricePerKwh: price,
            },
        });
    }

    // Put YOUR phone here (any format) to test fleet mode in Telegram. Always save phones normalized.
    const phone = normalizePhone('99999 99999', tenant.country as CountryCode);
    await prisma.tenantMembership.upsert({
        where: { tenantId_phone: { tenantId: tenant.id, phone } },
        update: {},
        create: {
            tenantId: tenant.id,
            phone,
            role: 'FLEET',
            name: 'Test Driver',
        },
    });
}

main().finally(() => prisma.$disconnect());
