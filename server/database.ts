import pg from 'pg';

export function createPool(connectionString: string, options: { max?: number; schema?: string } = {}) {
  if (options.schema && !/^[a-z][a-z0-9_]*$/.test(options.schema)) throw new Error('Invalid database schema');
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000, statement_timeout: 10_000, idle_in_transaction_session_timeout: 10_000,
    application_name: 'agentic-v3', ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}) });
  pool.on('error', () => { console.error('数据库连接中断；连接池将重新建立连接。'); });
  return pool;
}
