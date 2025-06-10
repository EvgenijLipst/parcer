// get_holders_ethplorer.js
// Импортируем необходимые библиотеки
const axios = require('axios');
const { Pool } = require('pg');

// --- НАСТРОЙКИ, КОТОРЫЕ МОЖНО ЛЕГКО МЕНЯТЬ ---
const CONFIG = {
    // Пороги роста в процентах для отправки алертов
    growthThresholds: {
        vsPrevious: 0.3, // с момента прошлой записи (30 мин)
        last1Hour: 0.8,
        last3Hours: 1.0,
        last12Hours: 3.0,
        last24Hours: 5.0,
    },
    // Настройки для API
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN, // Токен вашего бота
        chatId: process.env.TELEGRAM_CHAT_ID,     // ID вашего чата или канала
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY,       // Ваш API ключ OpenAI
        model: 'gpt-4o',                       // Модель для анализа
    },
    // Интервал удаления старых данных
    cleanupIntervalHours: 24,
};

// --- КОНЕЦ НАСТРОЕК ---


// Инициализация пула соединений с базой данных PostgreSQL
// URL берется из переменных окружения Railway (DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Часто требуется для подключения к облачным базам данных
    }
});

// Основная асинхронная функция
(async () => {
    console.log('Запуск скрипта...');

    // 1. Создание таблицы, если она не существует
    await pool.query(`
        CREATE TABLE IF NOT EXISTS holders (
            id SERIAL PRIMARY KEY,
            contract TEXT NOT NULL,
            symbol TEXT,
            holders INTEGER,
            error TEXT,
            parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    `);

    // 2. Получение списка контрактов из аргументов командной строки
    const contracts = process.argv.slice(2);
    if (!contracts.length) {
        console.error("Ошибка: Не указаны адреса контрактов для парсинга.");
        console.error("Пример: node get_holders_ethplorer.js <contract1> [contract2]…");
        process.exit(1);
    }
    console.log(`Получено ${contracts.length} контрактов для обработки.`);

    // 3. Парсинг данных о холдерах
    const newRecords = [];
    for (const contract of contracts) {
        await new Promise(res => setTimeout(res, 1000)); // Пауза для обхода rate limit'ов API

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

    // 4. Запись новых данных в базу
    for (const r of newRecords) {
        if (r.error) continue; // Не записываем и не анализируем ошибочные записи
        await pool.query(
            `INSERT INTO holders(contract, symbol, holders, error) VALUES($1, $2, $3, $4)`,
            [r.contract, r.symbol, r.holders, r.error]
        );
    }
    console.log(`✅ ${newRecords.filter(r => !r.error).length} новых записей сохранено в базу.`);

    // 5. Анализ роста и отправка алертов для каждой новой записи
    console.log('\n--- Начало анализа роста ---');
    for (const record of newRecords) {
        if (record.error) continue; // Пропускаем анализ, если при парсинге была ошибка

        const historyQuery = `
            SELECT
                (SELECT h.holders FROM holders h WHERE h.contract = $1 ORDER BY h.parsed_at DESC LIMIT 1) AS current_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 ORDER BY h.parsed_at DESC LIMIT 1 OFFSET 1) AS prev_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '1 hour' ORDER BY h.parsed_at DESC LIMIT 1) AS h1_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '3 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h3_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '12 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h12_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '24 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h24_holders
        `;
        const { rows: [history] } = await pool.query(historyQuery, [record.contract]);

        if (!history || !history.current_holders) continue;

        const growth = {
            vsPrevious: calculateGrowth(history.current_holders, history.prev_holders),
            last1Hour: calculateGrowth(history.current_holders, history.h1_holders),
            last3Hours: calculateGrowth(history.current_holders, history.h3_holders),
            last12Hours: calculateGrowth(history.current_holders, history.h12_holders),
            last24Hours: calculateGrowth(history.current_holders, history.h24_holders),
        };

        const shouldAlert =
            growth.vsPrevious >= CONFIG.growthThresholds.vsPrevious ||
            growth.last1Hour >= CONFIG.growthThresholds.last1Hour ||
            growth.last3Hours >= CONFIG.growthThresholds.last3Hours ||
            growth.last12Hours >= CONFIG.growthThresholds.last12Hours ||
            growth.last24Hours >= CONFIG.growthThresholds.last24Hours;

        if (shouldAlert) {
            console.log(`[ALERT] Обнаружен значительный рост для токена ${record.symbol} (${record.contract})`);
            
            const alertPayload = {
                timestamp: new Date().toISOString(),
                symbol: record.symbol,
                contract: record.contract,
                growth_vs_previous: `${growth.vsPrevious.toFixed(2)}%`,
                growth_1h: `${growth.last1Hour.toFixed(2)}%`,
                growth_3h: `${growth.last3Hours.toFixed(2)}%`,
                growth_12h: `${growth.last12Hours.toFixed(2)}%`,
                growth_24h: `${growth.last24Hours.toFixed(2)}%`,
            };

            await sendTelegramAlert(alertPayload);
            await sendOpenAIAlert(alertPayload);
        } else {
             console.log(`Рост для ${record.symbol} в пределах нормы.`);
        }
    }
    console.log('--- Анализ роста завершен ---\n');


    // 6. Удаление старых данных
    console.log(`Удаление данных старше ${CONFIG.cleanupIntervalHours} часов...`);
    const deleteResult = await pool.query(`
        DELETE FROM holders WHERE parsed_at < NOW() - INTERVAL '${CONFIG.cleanupIntervalHours} hours'
    `);
    console.log(`🧹 Удалено ${deleteResult.rowCount} старых записей.`);

})().catch(e => {
    console.error('Критическая ошибка в работе скрипта:', e);
    process.exit(1);
}).finally(async () => {
    await pool.end();
    console.log('Работа скрипта завершена. Соединение с базой данных закрыто.');
});


// --- Вспомогательные функции ---

function calculateGrowth(current, previous) {
    if (previous === null || previous === undefined || current <= previous) {
        return 0;
    }
    return ((current - previous) / previous) * 100;
}

async function sendTelegramAlert(payload) {
    if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
        console.warn('Переменные для Telegram не настроены. Алерт пропущен.');
        return;
    }
    const message = `
📈 **Обнаружен рост холдеров!**
-----------------------------------
**Токен:** ${payload.symbol}
**Контракт:** \`${payload.contract}\`
**Время:** ${payload.timestamp}
-----------------------------------
**Рост с прошлой записи:** ${payload.growth_vs_previous}
**Рост за 1 час:** ${payload.growth_1h}
**Рост за 3 часа:** ${payload.growth_3h}
**Рост за 12 часов:** ${payload.growth_12h}
**Рост за 24 часа:** ${payload.growth_24h}
    `;
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: CONFIG.telegram.chatId,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log(`🚀 Алерт для ${payload.symbol} успешно отправлен в Telegram.`);
    } catch (error) {
        console.error('Ошибка отправки алерта в Telegram:', error.response ? error.response.data : error.message);
    }
}

async function sendOpenAIAlert(payload) {
    if (!CONFIG.openai.apiKey) {
        console.warn('API ключ OpenAI не настроен. Алерт пропущен.');
        return;
    }
    const prompt = `Проанализируй следующие данные о росте холдеров токена и дай краткую сводку. Токен: ${payload.symbol}. Рост за 1 час: ${payload.growth_1h}, рост за 24 часа: ${payload.growth_24h}.`;
    try {
        await axios.post('https://api.openai.com/v1/chat/completions', {
            model: CONFIG.openai.model,
            messages: [
                { role: 'system', content: 'You are a crypto market analyst.' },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${CONFIG.openai.apiKey}` }
        });
        console.log(`🧠 Данные для ${payload.symbol} успешно отправлены в ChatGPT.`);
    } catch (error) {
        console.error('Ошибка отправки данных в OpenAI:', error.response ? error.response.data : error.message);
    }
}