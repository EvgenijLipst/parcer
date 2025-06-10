// get_holders_ethplorer.js (ВЕРСИЯ ДЛЯ ГЛУБОКОЙ ДИАГНОСТИКИ)
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

        // =================================================================
        //            НАЧАЛО БЛОКА ГЛУБОКОЙ ДИАГНОСТИКИ
        // =================================================================
        console.log(`\n--- ДИАГНОСТИКА ПЕРЕД СБОЕМ для токена: ${record.symbol || 'N/A'} ---`);
        console.log(`Is test mode active? (testPreviousValue !== null):`, testPreviousValue !== null);
        
        console.log(`\n--- Переменная 'record' ---`);
        console.log(`Тип record: ${typeof record}`);
        console.log(`Содержимое record:`, record);
        console.log(`Значение record.contract: ${record.contract}`);
        console.log(`Тип record.contract: ${typeof record.contract}`);
        
        console.log(`\n--- Переменная 'testContract' ---`);
        console.log(`Тип testContract: ${typeof testContract}`);
        console.log(`Значение testContract: ${testContract}`);
        
        console.log('--- КОНЕЦ ДИАГНОСТИКИ ---');
        // =================================================================
        
        // Строка, на которой происходит сбой
        if (testPreviousValue !== null && testContract && record.contract && record.contract.toLowerCase() === testContract.toLowerCase()) {
            // ... (дальнейшая логика)
        }
        
        // ... (остальной код анализа без изменений)
    }
    console.log('--- Анализ роста завершен ---\n');

    const deleteResult = await pool.query(`DELETE FROM holders WHERE parsed_at < NOW() - INTERVAL '${CONFIG.cleanupIntervalHours} hours'`);
    console.log(`🧹 Удалено ${deleteResult.rowCount} старых записей.`);

})().catch(e => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА:', e);
    process.exit(1);
}).finally(async () => {
    await pool.end();
    console.log('Работа скрипта завершена.');
});

// Вспомогательные функции остаются без изменений
// ...