// get_holders_ethplorer.js (ИСПРАВЛЕННАЯ ВЕРСИЯ)
const axios = require('axios');
const { Pool } = require('pg');

const CONFIG = {
    growthThresholds: {
        vsPrevious: 0.3,
        last1Hour: 0.8,
        last3Hours: 1.0,
        last12Hours: 3.0,
        last24Hours: 5.0,
    },
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4o',
    },
    cleanupIntervalHours: 24,
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    console.log('Запуск скрипта...');

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

    const contracts = process.argv.slice(2);
    if (!contracts.length) {
        console.error("Ошибка: Не указаны адреса контрактов для парсинга.");
        process.exit(1);
    }
    console.log(`Получено ${contracts.length} контрактов для обработки.`);

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
        await pool.query(
            `INSERT INTO holders(contract, symbol, holders, error) VALUES($1, $2, $3, $4)`,
            [r.contract, r.symbol, r.holders, r.error]
        );
    }
    console.log(`✅ ${newRecords.filter(r => !r.error).length} новых записей сохранено в базу.`);

    console.log('\n--- Начало анализа роста ---');
    for (const record of newRecords) {
        if (record.error || !record.holders) continue; 

        // ИСПРАВЛЕНИЕ: Теперь мы запрашиваем ТОЛЬКО исторические данные.
        // Текущее значение берется из памяти (record.holders).
        const historyQuery = `
            SELECT
                (SELECT h.holders FROM holders h WHERE h.contract = $1 ORDER BY h.parsed_at DESC LIMIT 1 OFFSET 1) AS prev_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '1 hour' ORDER BY h.parsed_at DESC LIMIT 1) AS h1_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '3 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h3_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '12 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h12_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '24 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h24_holders
        `;
        const { rows: [history] } = await pool.query(historyQuery, [record.contract]);

        // Мы больше не используем отладочный лог, так как исправили логику.
        // Если захотите вернуть, можете вставить его сюда.

        if (!history) continue;

        // ИСПРАВЛЕНИЕ: Используем `record.holders` как текущее значение.
        const currentHolders = record.holders;

        const growth = {
            vsPrevious: calculateGrowth(currentHolders, history.prev_holders),
            last1Hour: calculateGrowth(currentHolders, history.h1_holders),
            last3Hours: calculateGrowth(currentHolders, history.h3_holders),
            last12Hours: calculateGrowth(currentHolders, history.h12_holders),
            last24Hours: calculateGrowth(currentHolders, history.h24_holders),
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

    const deleteResult = await pool.query(
        `DELETE FROM holders WHERE parsed_at < NOW() - INTERVAL '${CONFIG.cleanupIntervalHours} hours'`
    );
    console.log(`🧹 Удалено ${deleteResult.rowCount} старых записей.`);

})().catch(e => {
    console.error('Критическая ошибка в работе скрипта:', e);
    process.exit(1);
}).finally(async () => {
    await pool.end();
    console.log('Работа скрипта завершена. Соединение с базой данных закрыто.');
});

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