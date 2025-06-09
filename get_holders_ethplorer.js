// get_holders_ethplorer.js
// npm install axios

const axios = require('axios');

(async () => {
  const contracts = process.argv.slice(2);
  if (contracts.length === 0) {
    console.error('Usage: node get_holders_ethplorer.js <contract1> [contract2] [contract3] …');
    process.exit(1);
  }

  // Публичный ключ Ethplorer
  const API_KEY = 'freekey';
  const UA      = { 'User-Agent': 'Mozilla/5.0' };

  // Для каждого контракта делаем запрос к Ethplorer
  const jobs = contracts.map(async (contract) => {
    try {
      const url  = `https://api.ethplorer.io/getTokenInfo/${contract}?apiKey=${API_KEY}`;
      const { data } = await axios.get(url, { headers: UA });
      if (data.error) throw new Error(data.error.message);
      return {
        contract,
        symbol: data.symbol || '',
        holders: typeof data.holdersCount === 'number'
          ? data.holdersCount
          : null
      };
    } catch (e) {
      return { contract, symbol: '', holders: null, error: e.message };
    }
  });

  // Ждём всех запросов
  const results = await Promise.all(jobs);

  // Выводим в виде таблицы
  console.table(
    results.map(r => ({
      Contract: r.contract,
      Symbol:   r.symbol,
      Holders:  r.holders != null ? r.holders.toLocaleString() : 'Error',
      Error:    r.error || ''
    }))
  );
})();
