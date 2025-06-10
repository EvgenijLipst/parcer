// get_holders_ethplorer.js (ВЕРСИЯ ДЛЯ ФИНАЛЬНОЙ ОТЛАДКИ)
const axios = require('axios');
const { Pool } = require('pg');

const CONFIG = {
    growthThresholds: { vsPrevious: 0.3, last1Hour: 0.8, last3Hours: 1.0, last12Hours: 3.0, last24Hours: 5.0 },
    telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    openai: { apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o' },
    cleanupIntervalHours: 24,
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    console.log('Запуск скрипта...');

    let contracts;
    let testPreviousValue = null;
    let testContract = null;

    if (process.argv[2] === '--test') {
        testContract = process.argv[3];
        testPreviousValue = process.argv[4] ? parseInt(process.argv[4], 10) : null;
        contracts = [testContract];
        
        console.log(`--- ЗАПУСК В ТЕСТОВОМ РЕЖИМЕ для контракта ${testContract} ---`);
        if (!testContract || testPreviousValue === null) {
            console.error("Ошибка: для тестового режима укажите --test <контракт> <значение>");
            process.exit(1);
        }
    } else {
        contracts = process.argv.slice(2);
    }

    if (!contracts || !contracts.length || (contracts.length === 1 && contracts[0] === undefined)) {
        console.error("Ошибка: Не указаны адреса контрактов для парсинга.");
        process.exit(1);
    }
    console.log(`Получено ${contracts.length} контрактов для обработки.`);

    await pool.query(`CREATE TABLE IF NOT EXISTS holders (id SERIAL PRIMARY KEY, contract TEXT NOT NULL, symbol TEXT, holders INTEGER, error TEXT, parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW())`);

    const newRecords = [];
    for (const contract of contracts) {
        if (!contract) continue;
        await new Promise(res => setTimeout(res, 1000));
        try {
            const { data } = await axios.get(`https://api.ethplorer.io/getTokenInfo/${contract}?apiKey=freekey`);
            if (data.address && data.symbol && data.holdersCount) {
                newRecords.push({ contract: data.address, symbol: data.symbol, holders: data.holdersCount, error: "" });
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
        if (r.error || !r.contract) continue;
        await pool.query(`INSERT INTO holders(contract, symbol, holders, error) VALUES($1, $2, $3, $4)`, [r.contract, r.symbol, r.holders, r.error]);
    }
    console.log(`✅ ${newRecords.filter(r => !r.error).length} новых записей сохранено в базу.`);

    console.log('\n--- Начало анализа роста ---');
    for (const record of newRecords) {
        if (record.error || !record.holders || !record.contract) {
            console.log(`Пропускаем анализ для записи, т.к. в ней ошибка или нет данных:`, record);
            continue;
        }

        const historyQuery = `
            SELECT
                (SELECT h.holders FROM holders h WHERE h.contract ILIKE $1 ORDER BY h.parsed_at DESC LIMIT 1 OFFSET 1) AS prev_holders,
                (SELECT h.holders FROM holders h WHERE h.contract ILIKE $1 AND h.parsed_at <= NOW() - INTERVAL '1 hour' ORDER BY h.parsed_at DESC LIMIT 1) AS h1_holders,
                (SELECT h.holders FROM holders h WHERE h.contract ILIKE $1 AND h.parsed_at <= NOW() - INTERVAL '3 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h3_holders,
                (SELECT h.holders FROM holders h WHERE h.contract ILIKE $1 AND h.parsed_at <= NOW() - INTERVAL '12 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h12_holders,
                (SELECT h.holders FROM holders h WHERE h.contract ILIKE $1 AND h.parsed_at <= NOW() - INTERVAL '24 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h24_holders
        `;
        const { rows: [history] } = await pool.query(historyQuery, [record.contract]);

        if (!history) continue;
        
        // --- ДИАГНОСТИКА ПЕРЕД СБОЕМ ---
        console.log(`\n[ПРОВЕРКА ПЕРЕД СРАВНЕНИЕМ] для токена ${record.symbol}`);
        console.log(`> Тип record.contract: ${typeof record.contract}, Значение: ${record.contract}`);
        console.log(`> Тип testContract: ${typeof testContract}, Значение: ${testContract}`);
        console.log(`> Тип testPreviousValue: ${typeof testPreviousValue}, Значение: ${testPreviousValue}`);
        // --- КОНЕЦ ДИАГНОСТИКИ ---

        // Усиленная проверка: Сначала убеждаемся, что обе переменных существуют
        if (testPreviousValue !== null && testContract && record.contract && record.contract.toLowerCase() === testContract.toLowerCase()) {
            history.prev_holders = testPreviousValue;
            console.log(`[РЕЖИМ ТЕСТА] Для ${record.symbol} используется поддельное предыдущее значение: ${testPreviousValue}`);
        }

        const currentHolders = record.holders;
        const growth = {
            vsPrevious: calculateGrowth(currentHolders, history.prev_holders),
            last1Hour: calculateGrowth(currentHolders, history.h1_holders),
            last3Hours: calculateGrowth(currentHolders, history.h3_holders),
            last12Hours: calculateGrowth(currentHolders, history.h12_holders),
            last24Hours: calculateGrowth(currentHolders, history.h24_holders),
        };

        const shouldAlert = growth.vsPrevious >= CONFIG.growthThresholds.vsPrevious || growth.last1Hour >= CONFIG.growthThresholds.last1Hour || growth.last3Hours >= CONFIG.growthThresholds.last3Hours || growth.last12Hours >= CONFIG.growthThresholds.last12Hours || growth.last24Hours >= CONFIG.growthThresholds.last24Hours;

        if (shouldAlert) {
            console.log(`[ALERT] Обнаружен значительный рост для токена ${record.symbol} (${record.contract})`);
            const alertPayload = { timestamp: new Date().toISOString(), symbol: record.symbol, contract: record.contract, growth_vs_previous: `${growth.vsPrevious.toFixed(2)}%`, growth_1h: `${growth.last1Hour.toFixed(2)}%`, growth_3h: `${growth.last3Hours.toFixed(2)}%`, growth_12h: `${growth.last12Hours.toFixed(2)}%`, growth_24h: `${growth.last24Hours.toFixed(2)}%`};
            await sendTelegramAlert(alertPayload);
            // ... вызов OpenAI ...
        } else {
             console.log(`Рост для ${record.symbol} в пределах нормы.`);
        }
    }
    console.log('--- Анализ роста завершен ---\n');

    const deleteResult = await pool.query(`DELETE FROM holders WHERE parsed_at < NOW() - INTERVAL '${CONFIG.cleanupIntervalHours} hours'`);
    console.log(`🧹 Удалено ${deleteResult.rowCount} старых записей.`);

})().catch(e => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА:', e); // Добавил префикс для легкости поиска
    process.exit(1);
}).finally(async () => {
    await pool.end();
    console.log('Работа скрипта завершена.');
});

// Вспомогательные функции остаются без изменений
function calculateGrowth(current, previous) { if (previous === null || previous === undefined || current <= previous) { return 0; } return ((current - previous) / previous) * 100; }
async function sendTelegramAlert(payload) { /* ... код без изменений ... */ }
async function sendOpenAIAlert(payload) { /* ... код без изменений ... */ }