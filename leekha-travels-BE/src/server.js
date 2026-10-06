import 'dotenv/config';
import { createApp } from './app.js';
import { createSupabaseClients } from './supabase.js';

const { adminClient, authClientFactory } = createSupabaseClients();
const app = createApp({ adminClient, authClientFactory });
const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  console.log(`Leekha Travels backend listening on http://localhost:${port}`);
});