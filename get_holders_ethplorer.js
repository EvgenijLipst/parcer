const axios = require('axios');
const { Pool } = require('pg');

// Подключение к Railway Postgres
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  // 1. Создаём таблицу holders, если нет
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holders (
      id SERIAL PRIMARY KEY,
      contract TEXT,
      symbol   TEXT,
      holders  INTEGER,
      error    TEXT,
      parsed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // 2. Берём контракты из аргументов
  const contracts = process.argv.slice(2);
  if (!contracts.length) {
    console.error("Usage: node get_holders_ethplorer.js <contract1> [contract2]…");
    process.exit(1);
  }

  // 3. Запрашиваем данные и собираем в массив
  const results = [];
  for (const c of contracts) {
    try {
      const { data } = await axios.get(
        `https://api.ethplorer.io/getTokenInfo/${c}?apiKey=freekey`
      );
      results.push({ contract: c, symbol: data.symbol, holders: data.holdersCount, error: "" });
    } catch (e) {
      results.push({ contract: c, symbol: "", holders: 0, error: e.message });
    }
  }

  // 4. Логируем для отладки
  console.table(results);

  // 5. Сохраняем в таблицу holders
  for (const r of results) {
    await pool.query(
      `INSERT INTO holders(contract,symbol,holders,error) VALUES($1,$2,$3,$4)`,
      [r.contract, r.symbol, r.holders, r.error]
    );
  }

  // 6. Завершаем подключение и выходим
  await pool.end();
  console.log("✅ Сохранено в holders");
})().catch(e => {
  console.error(e);
  process.exit(1);
});
