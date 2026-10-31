import express from 'express';

const PORT = Number(process.env.PORT ?? 4000); // hosts/containers tell us the port via PORT
const app = express();
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});
const server = app.listen(PORT, () => console.log(`API on port ${PORT}`));

// Docker sends SIGTERM when it stops or replaces a container. Close cleanly instead of being killed.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
