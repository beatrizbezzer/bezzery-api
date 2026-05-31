import { createClient } from '@supabase/supabase-js'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require('ws')

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
  // Node 18 has no native WebSocket — pass ws explicitly
  { realtime: { transport: ws } }
)
