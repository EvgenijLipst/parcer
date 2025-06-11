// get_holders_ethplorer.js (ФИНАЛЬНАЯ ВЕРСИЯ 5.3: ПОЛНОСТЬЮ ИСПРАВЛЕНО ЗАВЕРШЕНИЕ)
const axios = require('axios');
const { Pool } = require('pg');

const CONFIG = {
    growthThresholds: { vsPrevious: 0.3, last1Hour: 0.8, last3Hours: 1.0, last12Hours: 3.0, last24Hours: 5.0 },
    telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    openai: { apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o' },
    cleanupIntervalHours: 48, 
    apiPauseMs: 2000,
    searchWindowMinutes: 10,
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const main = async () => {
    console.log('Запуск скрипта...');

    let contracts;
    let testPreviousValue = null;
    let testContract = null;
    let isTestMode = false;

    if (process.argv[2] === '--test') {
        isTestMode = true;
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

    if (!contracts || !contracts.length || (contracts.length === 1 && !contracts[0])) {
        console.error("Ошибка: Не указаны адреса контрактов для парсинга.");
        process.exit(1);
    }
    console.log(`Получено ${contracts.length} контрактов для обработки.`);

    await pool.query(`CREATE TABLE IF NOT EXISTS holders (id SERIAL PRIMARY KEY, contract TEXT NOT NULL, symbol TEXT, holders INTEGER, error TEXT, parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW())`);

    const apiKey = process.env.ETHPLORER_API_KEY || 'freekey';
    console.log(`Используем API ключ: ${apiKey === 'freekey' ? 'публичный freekey' : 'персональный'}`);

    const newRecords = [];
    for (const contract of contracts) {
        if (!contract) continue;
        await new Promise(res => setTimeout(res, CONFIG.apiPauseMs)); 
        try {
            const { data } = await axios.get(`https://api.ethplorer.io/getTokenInfo/${contract}?apiKey=${apiKey}`);
            if (data.address && data.symbol && data.holdersCount) {
                newRecords.push({ contract: data.address, symbol: data.symbol, holders: data.holdersCount, error: "" });
            } else {
                console.log(`[DEBUG] Получен невалидный ответ для контракта ${contract}:`, data);
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
        try {
            if (record.error || !record.holders || !record.contract) continue;

            const historyQuery = `
                WITH vars AS ( SELECT NOW() - INTERVAL '1 hour' AS h1_target, NOW() - INTERVAL '3 hours' AS h3_target, NOW() - INTERVAL '12 hours' AS h12_target, NOW() - INTERVAL '24 hours' AS h24_target, INTERVAL '${CONFIG.searchWindowMinutes} minutes' AS window )
                SELECT
                    (SELECT h.holders FROM holders h WHERE h.contract ILIKE $1 ORDER BY h.parsed_at DESC LIMIT 1 OFFSET 1) AS prev_holders,
                    (SELECT h.holders FROM holders h, vars WHERE h.contract ILIKE $1 AND h.parsed_at BETWEEN (vars.h1_target - vars.window) AND (vars.h1_target + vars.window) ORDER BY ABS(EXTRACT(EPOCH FROM (h.parsed_at - vars.h1_target))) LIMIT 1) AS h1_holders,
                    (SELECT h.holders FROM holders h, vars WHERE h.contract ILIKE $1 AND h.parsed_at BETWEEN (vars.h3_target - vars.window) AND (vars.h3_target + vars.window) ORDER BY ABS(EXTRACT(EPOCH FROM (h.parsed_at - vars.h3_target))) LIMIT 1) AS h3_holders,
                    (SELECT h.holders FROM holders h, vars WHERE h.contract ILIKE $1 AND h.parsed_at BETWEEN (vars.h12_target - vars.window) AND (vars.h12_target + vars.window) ORDER BY ABS(EXTRACT(EPOCH FROM (h.parsed_at - vars.h12_target))) LIMIT 1) AS h12_holders,
                    (SELECT h.holders FROM holders h, vars WHERE h.contract ILIKE $1 AND h.parsed_at BETWEEN (vars.h24_target - vars.window) AND (vars.h24_target + vars.window) ORDER BY ABS(EXTRACT(EPOCH FROM (h.parsed_at - vars.h24_target))) LIMIT 1) AS h24_holders
            `;
            const { rows: [history] } = await pool.query(historyQuery, [record.contract]);

            if (!history) continue;
            
            if (isTestMode && record.contract.toLowerCase() === testContract.toLowerCase()) {
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
                console.log('-> Делаем паузу (2 сек) перед запросом к OpenAI...');
                await new Promise(res => setTimeout(res, 2000));
                await sendOpenAIAlert(alertPayload);
            } else {
                 console.log(`Рост для ${record.symbol} в пределах нормы.`);
            }
        } catch (error) {
            console.error(`\n❌ Произошла ошибка при анализе токена ${record.symbol} (${record.contract}):`);
            console.error(error);
        }
    }
    console.log('--- Анализ роста завершен ---\n');

    const deleteResult = await pool.query(`DELETE FROM holders WHERE parsed_at < NOW() - INTERVAL '${CONFIG.cleanupIntervalHours} hours'`);
    console.log(`🧹 Удалено ${deleteResult.rowCount} старых записей.`);
};

main()
    .then(() => {
        console.log('Работа скрипта успешно завершена.');
    })
    .catch(e => {
        console.error('КРИТИЧЕСКАЯ ОШИБКА В РАБОТЕ СКРИПТА:', e);
        process.exit(1);
    })
    .finally(() => {
        // Закрываем пул соединений в любом случае: при успехе или при ошибке
        pool.end();
        console.log('Соединение с базой данных закрыто.');
    });


// --- Вспомогательные функции (без изменений) ---
function calculateGrowth(current, previous) { /* ... */ }
async function sendTelegramAlert(payload) { /* ... */ }
async function sendOpenAIAlert(payload) { /* ... */ }