import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import ordersRouter from './routes/orders.js';
import trackingRouter from './routes/tracking.js';
import adminRouter from './routes/admin.js';
import routesRouter from './routes/routes.js';
import { startOrderSync } from './services/orderSync.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());

app.use('/api/orders', ordersRouter);
app.use('/api/tracking', trackingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/routes', routesRouter);

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startOrderSync();
});
