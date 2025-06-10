// ВРЕМЕННЫЙ ОТЛАДОЧНЫЙ СКРИПТ
const axios = require('axios');
const { Pool } = require('pg');

// ... (Секция CONFIG остается без изменений) ...
const CONFIG = {
    growthThresholds: { vsPrevious: 0.3, last1Hour: 0.8, last3Hours: 1.0, last12Hours: 3.0, last24Hours: 5.0, },
    telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, },
    openai: { apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o', },
    cleanupIntervalHours: 24,
};


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    console.log('--- ЗАПУСК В РЕЖИМЕ ГЛУБОКОЙ ОТЛАДКИ ---');
    
    // ... (Создание таблицы и получение контрактов без изменений) ...
    await pool.query(`CREATE TABLE IF NOT EXISTS holders (id SERIAL PRIMARY KEY, contract TEXT NOT NULL, symbol TEXT, holders INTEGER, error TEXT, parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW())`);
    const contracts = process.argv.slice(2);
    if (!contracts.length) { console.error("Ошибка: Не указаны адреса контрактов."); process.exit(1); }
    console.log(`Получено ${contracts.length} контрактов для обработки.`);

    // ... (Парсинг и запись в базу без изменений) ...
    const newRecords = [];
    for (const contract of contracts) {
        await new Promise(res => setTimeout(res, 1000));
        try {
            const { data } = await axios.get(`https://api.ethplorer.io/getTokenInfo/${contract}?apiKey=freekey`);
            if (data.symbol && data.holdersCount) {
                newRecords.push({ contract, symbol: data.symbol, holders: data.holdersCount, error: "" });
            } else {
                newRecords.push({ contract, symbol: 'N/A', holders: 0, error: "Invalid data from API" });
            }
        } catch (e) {
            newRecords.push({ contract, symbol: 'N/A', holders: 0, error: e.message });
        }
    }
    console.log('Данные о холдерах успешно спарсены:');
    console.table(newRecords);

    for (const r of newRecords) {
        if (r.error) continue;
        await pool.query(`INSERT INTO holders(contract, symbol, holders, error) VALUES($1, $2, $3, $4)`,[r.contract, r.symbol, r.holders, r.error]);
    }
    console.log(`✅ ${newRecords.filter(r => !r.error).length} новых записей сохранено в базу.`);


    console.log('\n--- Начало анализа роста ---');
    // Анализируем только ПЕРВЫЙ токен в списке для чистоты лога
    const record = newRecords[0];
    if (!record || record.error || !record.holders) {
        console.log('Первый токен в списке содержит ошибку или нет данных. Выход.');
        process.exit(0);
    }

    console.log(`\n1. Анализируем токен: ${record.symbol} с контрактом ${record.contract}`);
    console.log(`2. Свежее значение холдеров (из API, в памяти): ${record.holders}`);

    const historyQuery = `
        SELECT * FROM holders WHERE contract = $1 ORDER BY parsed_at DESC LIMIT 2
    `;
    const { rows: historyRows } = await pool.query(historyQuery, [record.contract]);

    console.log(`3. Запрос в базу (${historyQuery.trim()}) вернул ${historyRows.length} строк(у/и).`);
    console.log('4. Вот эти строки целиком (самая новая - первая):');
    console.table(historyRows);

    if (historyRows.length < 2) {
        console.log('5. Найдено меньше двух записей. Сравнение невозможно. Рост = 0%.');
    } else {
        const currentDbValue = historyRows[0].holders;
        const previousDbValue = historyRows[1].holders;
        console.log(`5. Самое свежее значение в базе: ${currentDbValue} (за ${historyRows[0].parsed_at})`);
        console.log(`6. ПРЕДЫДУЩЕЕ значение в базе: ${previousDbValue} (за ${historyRows[1].parsed_at})`);

        const growth = ((record.holders - previousDbValue) / previousDbValue) * 100;
        console.log(`7. РАСЧЕТ: ((${record.holders} - ${previousDbValue}) / ${previousDbValue}) * 100 = ${growth.toFixed(2)}%`);
        
        if (growth >= CONFIG.growthThresholds.vsPrevious) {
            console.log('РЕЗУЛЬТАТ: Рост ПРЕВЫШАЕТ порог 0.3%. Должен быть алерт.');
        } else {
            console.log('РЕЗУЛЬТАТ: Рост В ПРЕДЕЛАХ НОРМЫ.');
        }
    }

})().catch(e => {
    console.error('Критическая ошибка в работе скрипта:', e);
    process.exit(1);
}).finally(async () => {
    await pool.end();
    console.log('--- ОТЛАДОЧНЫЙ ЗАПУСК ЗАВЕРШЕН ---');
});