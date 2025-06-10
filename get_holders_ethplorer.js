// get_holders_ethplorer.js (ФИНАЛЬНАЯ РАБОЧАЯ ВЕРСИЯ 2.0)
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

    let contracts;
    let testPreviousValue = null;
    let testContract = null;

    // Проверяем, запущен ли скрипт в тестовом режиме
    if (process.argv[2] === '--test') {
        // Формат тестового запуска: node get_holders_ethplorer.js --test <контракт> <значение>
        testContract = process.argv[3];
        testPreviousValue = process.argv[4] ? parseInt(process.argv[4], 10) : null;
        contracts = [testContract]; // В тестовом режиме работаем только с одним контрактом
        
        console.log(`--- ЗАПУСК В ТЕСТОВОМ РЕЖИМЕ для контракта ${testContract} ---`);
        if (!testContract || testPreviousValue === null) {
            console.error("Ошибка: для тестового режима укажите --test <контракт> <значение>");
            process.exit(1);
        }
    } else {
        // Обычный рабочий режим со списком контрактов
        contracts = process.argv.slice(2);
    }

    if (!contracts || !contracts.length) {
        console.error("Ошибка: Не указаны адреса контрактов для парсинга.");
        process.exit(1);
    }
    console.log(`Получено ${contracts.length} контрактов для обработки.`);

    await pool.query(`CREATE TABLE IF NOT EXISTS holders (id SERIAL PRIMARY KEY, contract TEXT NOT NULL, symbol TEXT, holders INTEGER, error TEXT, parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW())`);

    const newRecords = [];
    for (const contract of contracts) {
        await new Promise(res => setTimeout(res, 1000));
        try {
            const { data } = await axios.get(`https://api.ethplorer.io/getTokenInfo/${contract}?apiKey=freekey`);
            if (data.address && data.symbol && data.holdersCount) {
                // Используем адрес из ответа API для консистентности регистра
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
        if (r.error) continue;
        await pool.query(`INSERT INTO holders(contract, symbol, holders, error) VALUES($1, $2, $3, $4)`, [r.contract, r.symbol, r.holders, r.error]);
    }
    console.log(`✅ ${newRecords.filter(r => !r.error).length} новых записей сохранено в базу.`);

    console.log('\n--- Начало анализа роста ---');
    for (const record of newRecords) {
        if (record.error || !record.holders) continue;

        const historyQuery = `
            SELECT
                (SELECT h.holders FROM holders h WHERE h.contract = $1 ORDER BY h.parsed_at DESC LIMIT 1 OFFSET 1) AS prev_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '1 hour' ORDER BY h.parsed_at DESC LIMIT 1) AS h1_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '3 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h3_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '12 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h12_holders,
                (SELECT h.holders FROM holders h WHERE h.contract = $1 AND h.parsed_at <= NOW() - INTERVAL '24 hours' ORDER BY h.parsed_at DESC LIMIT 1) AS h24_holders
        `;
        const { rows: [history] } = await pool.query(historyQuery, [record.contract]);

        if (!history) continue;

        // Применяем тестовое значение, если мы в тестовом режиме (сравнение без учета регистра)
        if (testPreviousValue !== null && record.contract.toLowerCase() === testContract.toLowerCase()) {
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
            await sendOpenAIAlert(alertPayload);
        } else {
             console.log(`Рост для ${record.symbol} в пределах нормы.`);
        }
    }
    console.log('--- Анализ роста завершен ---\n');

    const deleteResult = await pool.query(`DELETE FROM holders WHERE parsed_at < NOW() - INTERVAL '${CONFIG.cleanupIntervalHours} hours'`);
    console.log(`🧹 Удалено ${deleteResult.rowCount} старых записей.`);

})().catch(e => {
    console.error('Критическая ошибка в работе скрипта:', e);
    process.exit(1);
}).finally(async () => {
    await pool.end();
    console.log('Работа скрипта завершена. Соединение с базой данных закрыто.');
});

// --- Вспомогательные функции (без изменений) ---
function calculateGrowth(current, previous) { if (previous === null || previous === undefined || current <= previous) { return 0; } return ((current - previous) / previous) * 100; }
async function sendTelegramAlert(payload) { if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) { console.warn('Переменные для Telegram не настроены. Алерт пропущен.'); return; } const message = `📈 **Обнаружен рост холдеров!**\n-----------------------------------\n**Токен:** ${payload.symbol}\n**Контракт:** \`${payload.contract}\`\n**Время:** ${payload.timestamp}\n-----------------------------------\n**Рост с прошлой записи:** ${payload.growth_vs_previous}\n**Рост за 1 час:** ${payload.growth_1h}\n**Рост за 3 часа:** ${payload.growth_3h}\n**Рост за 12 часов:** ${payload.growth_12h}\n**Рост за 24 часа:** ${payload.growth_24h}`; const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`; try { await axios.post(url, { chat_id: CONFIG.telegram.chatId, text: message, parse_mode: 'Markdown' }); console.log(`🚀 Алерт для ${payload.symbol} успешно отправлен в Telegram.`); } catch (error) { console.error('Ошибка отправки алерта в Telegram:', error.response ? error.response.data : error.message); } }
async function sendOpenAIAlert(payload) { if (!CONFIG.openai.apiKey) { console.warn('API ключ OpenAI не настроен. Запрос пропущен.'); return; } const systemPrompt = `Выступай в роли **старшего криптовалютного аналитика** с 10-летним опытом работы в ведущих венчурных фондах и аналитических компаниях (таких как Messari, Nansen, Glassnode). Твой стиль — объективный, сжатый, основанный на данных. Ты умеешь быстро отделять хайп от реальных фактов. Твоя задача — провести **мгновенный и всесторонний 360-градусный анализ** токена, используя предоставленные данные как отправную точку, и представить результат в виде структурированного отчета на русском языке.`; const userPromptTemplate = `
# КОНТЕКСТ СИГНАЛА
Я предоставляю тебе оперативные данные о росте числа холдеров определенного токена. Этот рост может быть сигналом о потенциальных событиях, повышенном интересе или маркетинговой активности.
# ВХОДНЫЕ ДАННЫЕ ДЛЯ АНАЛИЗА
* **Название токена:** {TOKEN_NAME}
* **Адрес контракта (Ethereum):** {TOKEN_CONTRACT}
* **Динамика роста холдеров (сигнал):**
    * Рост за последние 30 минут (vs предыдущая запись): {GROWTH_VS_PREVIOUS}
    * Рост за 1 час: {GROWTH_1H}
    * Рост за 3 часа: {GROWTH_3H}
    * Рост за 12 часов: {GROWTH_12H}
    * Рост за 24 часа: {GROWTH_24H}
# ЗАДАЧИ ДЛЯ АНАЛИЗА (проработай каждый пункт)
1.  **События и Медиа-фон:** Проанализируй последние новости, анонсы в официальных каналах (X/Twitter, Discord, Blog) и упоминания в ключевых крипто-СМИ за последнюю неделю. Есть ли конкретный инфоповод или событие, которое могло спровоцировать рост?
2.  **Маркетинговая активность:** Оцени, не является ли рост результатом недавней маркетинговой кампании, Airdrop, конкурса или активной работы с инфлюенсерами.
3.  **Приток пользователей (On-chain):** Подтверждается ли рост холдеров реальной активностью в сети? Кратко проанализируй динамику объемов торгов на DEX (Uniswap, Sushiswap), количество транзакций и число активных адресов за последние дни.
4.  **Крупные игроки (Big Money):** Проверь последние крупные сделки по этому токену на Etherscan или в аналитических сервисах. Есть ли признаки входа/выхода фондов, "китов" или крупных инвесторов?
5.  **Настроения "Smart Money":** Как к этому токену относятся известные "умные кошельки" (smart money wallets)? Есть ли признаки накопления или продажи с их стороны? (Используй данные Nansen, Arkham, если возможно).
6.  **Общий сентимент (Sentiment):** Какой сейчас преобладает сентимент по токену в социальных сетях? Используй ключевые слова "bullish", "bearish", "scam", "gem".
7.  **Фундаментальный и Технический Анализ (FA/TA):**
    * **FA:** Дай краткую сводку (1-2 предложения) по сути проекта, его полезности (utility) и токеномике.
    * **TA:** Укажи ключевые уровни поддержки и сопротивления, а также текущее состояние основных индикаторов (например, RSI, MACD на дневном графике). Тренд восходящий, нисходящий или боковик?
8.  **Ключевые метрики:** Проверь текущую рыночную капитализацию (Market Cap), FDV (Fully Diluted Valuation) и циркулирующее предложение. Как эти показатели изменились за последнее время?
9.  **Оценка точки входа:** Проанализируй текущую ситуацию с точки зрения потенциального входа в позицию. Четко перечисли основные **бычьи факторы (ЗА)** и **медвежьи факторы (ПРОТИВ)**. Не давай прямого совета, а предоставь сбалансированную оценку.
10. **Анализ рисков:** Выяви и четко обозначь основные риски, связанные с токеном на данный момент (например, риски централизации, уязвимости смарт-контракта, регуляторные риски, низкая ликвидность).
# ФОРМАТ ВЫВОДА
Представь результат в виде структурированного отчета в формате Markdown с четкими заголовками для каждого из 10 пунктов анализа. В конце сделай краткое резюме.
# ОГРАНИЧЕНИЯ И СТИЛЬ
* Будь объективен. Если данных по какому-то пункту нет, так и напиши: "Данные отсутствуют" или "Не удалось определить".
* Используй профессиональную, но понятную лексику.
* **Обязательно добавь в конце отчета следующий дисклеймер:** *"Данный анализ носит информационный характер, основан на общедоступных данных и не является финансовой рекомендацией или призывом к действию. Всегда проводите собственное исследование (DYOR)."*
    `;
    const finalUserPrompt = userPromptTemplate.replace('{TOKEN_NAME}', payload.symbol).replace('{TOKEN_CONTRACT}', payload.contract).replace('{GROWTH_VS_PREVIOUS}', payload.growth_vs_previous).replace('{GROWTH_1H}', payload.growth_1h).replace('{GROWTH_3H}', payload.growth_3h).replace('{GROWTH_12H}', payload.growth_12h).replace('{GROWTH_24H}', payload.growth_24h);
    console.log(`Отправка запроса в OpenAI для токена ${payload.symbol}...`);
    try {
        await axios.post('https://api.openai.com/v1/chat/completions', { model: CONFIG.openai.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: finalUserPrompt }] }, { headers: { 'Authorization': `Bearer ${CONFIG.openai.apiKey}` }});
        console.log(`🧠 Ответ от OpenAI для ${payload.symbol} получен (в этой версии не обрабатывается).`);
    } catch (error) { console.error('Ошибка запроса к OpenAI:', error.response ? error.response.data.error.message : error.message); }
}