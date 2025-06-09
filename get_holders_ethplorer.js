const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
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

  const contracts = process.argv.slice(2);
  if (!contracts.length) {
    console.error("Usage: node get_holders_ethplorer.js <contract1> [contract2]…");
    process.exit(1);
  }

  const results = [];
  for (const c of contracts) {
    // пауза между запросами
    await new Promise(res => setTimeout(res, 1000));

    try {
      const { data } = await axios.get(
        `https://api.ethplorer.io/getTokenInfo/${c}?apiKey=freekey`
      );
      results.push({ contract: c, symbol: data.symbol, holders: data.holdersCount, error: "" });
    } catch (e) {
      results.push({ contract: c, symbol: "", holders: 0, error: e.message });
    }
  }

  console.table(results);

  for (const r of results) {
    await pool.query(
      `INSERT INTO holders(contract,symbol,holders,error) VALUES($1,$2,$3,$4)`,
      [r.contract, r.symbol, r.holders, r.error]
    );
  }

  await pool.end();
  console.log("✅ Сохранено в holders");
})().catch(e => {
  console.error(e);
  process.exit(1);
});
