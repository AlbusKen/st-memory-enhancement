import {BASE, DERIVED, EDITOR, SYSTEM, USER} from '../../core/manager.js';
import { executeIncrementalUpdateFromSummary, sheetsToTables } from "./absoluteRefresh.js";
import { newPopupConfirm } from '../../components/popupConfirm.js';
import { reloadCurrentChat } from "../../../../../../script.js"

let toBeExecuted = [];

/**
 * 初始化两步总结所需的数据
 * @param chat
 * */
function InitChatForTableTwoStepSummary(chat) {
    // 如果currentPiece.uid未定义，则初始化为随机字符串
    if (chat.uid === undefined) {
        chat.uid = SYSTEM.generateRandomString(22);
    }
    // 如果currentPiece.uid_that_references_table_step_update未定义，则初始化为{}
    if (chat.two_step_links === undefined) {
        chat.two_step_links = {};
    }
    // 如果currentPiece.uid_that_references_table_step_update未定义，则初始化为{}
    if (chat.two_step_waiting === undefined) {
        chat.two_step_waiting = {};
    }
}

/**
 * 获取当前滑动对话的唯一标识符
 * @param chat
 * @returns {string}
 */
function getSwipeUid(chat) {
    // 初始化chat
    InitChatForTableTwoStepSummary(chat);
    // 获取当前swipe的唯一标识符
    const swipeUid = `${chat.uid}_${chat.swipe_id}`;
    // 检查当前swipe是否已经存在必要的数据结构
    if (!(swipeUid in chat.two_step_links)) chat.two_step_links[swipeUid] = [];
    if (!(swipeUid in chat.two_step_waiting)) chat.two_step_waiting[swipeUid] = true;
    return swipeUid;
}

/**
 * 检查当前chat是否已经被父级chat执行过
 * @param chat
 * @param targetSwipeUid
 * @returns {*}
 */
function checkIfChatIsExecuted(chat, targetSwipeUid) {
    const chatSwipeUid = getSwipeUid(chat); // 获取当前chat的唯一标识符
    const chatExecutedSwipes = chat.two_step_links[chatSwipeUid]; // 获取当前chat已经执行过的父级chat
    return chatExecutedSwipes.includes(targetSwipeUid);   // 检查当前chat是否已经被目标chat执行过
}

/**
 * 从消息文本中提取纯文本内容，移除所有功能性标签和表格HTML。
 * @param {string} messageContent - 原始消息字符串.
 * @returns {string} - 清理后的纯文本.
 */
function getPureTextFromMessage(messageContent) {
    if (typeof messageContent !== 'string') return '';

    // 1. 移除已知的功能性 XML 标签
    let pureText = messageContent.replace(/<(tableEdit|think|thinking|plot)>[\s\S]*?<\/\1>/gs, '');

    // 2. 移除由表格渲染产生的特定HTML容器
    // 这包括 `.table_in_chat` 和可能的旧版 `.table-wrapper`
    pureText = pureText.replace(/<div class="table_in_chat[\s\S]*?<\/div>/gs, '');
    pureText = pureText.replace(/<div class="table-wrapper[\s\S]*?<\/div>/gs, '');

    // 3. 移除独立的 <table> 标签，以防有未被包裹的情况
    pureText = pureText.replace(/<table[\s\S]*?<\/table>/gs, '');
    
    // 4. (可选) 清理掉所有剩余的HTML标签，获得最纯净的文本
    // pureText = pureText.replace(/<[^>]+>/g, '');

    // 5. 清理多余的空行，使上下文更紧凑
    pureText = pureText.replace(/(\n\s*){3,}/g, '\n\n').trim();

    return pureText;
}

function MarkChatAsWaiting(chat, swipeUid) {
    console.log(USER.getContext().chat);
    console.log('chat.two_step_links:',chat.two_step_links);
    console.log('chat.two_step_waiting:',chat.two_step_waiting);
    chat.two_step_waiting[swipeUid] = true;
}

/**
 * 获取未执行的两步总结
 * @returns {string}
 * @param parentSwipeUid
 */
function GetUnexecutedMarkChats(parentSwipeUid) {
    const chats = USER.getContext().chat;
    let r = '';
    let lastChat = null;
    let cacheChat = null;
    let round = 0;
    // 统一从设置中读取历史记录数
    let contextLayers = USER.tableBaseSetting.step_by_step_history_count || USER.tableBaseSetting.separateReadContextLayers || 1;

    for (let i = chats.length - 1; i >= 0 && round < contextLayers; i--) {
        const chat = chats[i];
        if (chat.is_user === true) {
            toBeExecuted.unshift(chat);
            continue;
        }
        lastChat = cacheChat;
        cacheChat = chat;
        round++;

        // 如果当前对话已经被执行过，则跳过
        const iSwipeUid = getSwipeUid(chat);
        const isExecutedBySelf = checkIfChatIsExecuted(chat, iSwipeUid);
        if (isExecutedBySelf) break;
        const isExecutedByParent = checkIfChatIsExecuted(chat, parentSwipeUid);
        if (isExecutedByParent) break;

        // 将当前对话加入待执行列表
        toBeExecuted.unshift(chat);

        // 如果对话长度未达到阈值，则直接继续往前找
        if (toBeExecuted.length < USER.tableBaseSetting.step_by_step_threshold) continue;

        // 如果对话长度达到阈值，则通过标识符判断是否需要继续往前找
        const lastChatSwipeUid = getSwipeUid(lastChat);
        const isWaiting = chat.two_step_waiting[iSwipeUid] === true;
        if (!isWaiting) break;
    }
    return r;
}

/**
 * 执行两步总结
 * @param {boolean} [forceExecute=false] - 是否强制执行，跳过所有检查和确认
 * */
export async function TableTwoStepSummary(forceExecute = false) {
    if (USER.tableBaseSetting.isExtensionAble === false || USER.tableBaseSetting.step_by_step === false) return

    // 获取当前对话
    const chats = USER.getContext().chat;
    const currentPiece = chats[chats.length - 1];
    if (currentPiece.is_user === true) return;

    const swipeUid = getSwipeUid(currentPiece);
    if (currentPiece.mes.length < 20) {
        console.log('当前对话长度过短, 跳过执行分步总结: ', currentPiece.mes);
        MarkChatAsWaiting(currentPiece, swipeUid);
        return;
    }

    // 如果不开启多轮累计
    if (USER.tableBaseSetting.sum_multiple_rounds === false) {
        // 如果当前对话长度未达到阈值，则跳过，待出现能够执行的对话时再一起执行
        if (currentPiece.mes.length < USER.tableBaseSetting.step_by_step_threshold) {
            console.log('当前对话长度未达到阈值, 跳过执行分步总结: ', currentPiece.mes);
            MarkChatAsWaiting(currentPiece, swipeUid);
            return;
        }
    }

    // 往前找到所有未执行的两步总结
    toBeExecuted = [];
    GetUnexecutedMarkChats(swipeUid);

    // 如果没有找到需要执行的两步总结，则跳过
    if (toBeExecuted.length === 0) {
        console.log('未找到需要执行的两步总结: ', currentPiece.mes);
        MarkChatAsWaiting(currentPiece, swipeUid);
        return;
    }

    // 获取需要执行的两步总结,并确保只包含纯文本
    let todoChats = toBeExecuted.map(chat => getPureTextFromMessage(chat.mes)).join('\n\n');

    // 再次检查是否达到执行两步总结的阈值
    if (todoChats.length < USER.tableBaseSetting.step_by_step_threshold) {
        console.log('需要执行两步总结的对话长度未达到阈值: ', `(${todoChats.length}) `, toBeExecuted);
        MarkChatAsWaiting(currentPiece, swipeUid);
        return;
    }

    let proceed = forceExecute; // 如果是强制执行，则直接继续
    let confirmResult; // 将声明提前

    if (!forceExecute) {
        // 检查是否开启执行前确认
        const popupContentHtml = `<p>累计 ${todoChats.length} 长度的待总结文本，是否执行分步总结？</p>`;
        const popupId = 'stepwiseSummaryConfirm';
        confirmResult = await newPopupConfirm(
            popupContentHtml,
            "取消",
            "执行总结",
            popupId,
            "一直选是"
        );
        console.log('newPopupConfirm result for stepwise summary:', confirmResult);

        if (confirmResult === false) {
            console.log('用户取消执行分步总结: ', `(${todoChats.length}) `, toBeExecuted);
            MarkChatAsWaiting(currentPiece, swipeUid);
        } else {
            proceed = true; // 用户确认或已选择“一直选是”
            if (confirmResult === 'dont_remind_active') {
                console.log('分步总结弹窗已被禁止，自动执行。');
                EDITOR.info('已选择“一直选是”，操作将在后台自动执行...');
            } else {
                console.log('用户确认执行分步总结 (或首次选择了“一直选是”并确认)');
            }
        }
    }

    if (proceed) {
        // 获取当前表格数据
        const { piece: lastPiece } = BASE.getLastSheetsPiece();
        if (!lastPiece) {
            EDITOR.error('无法获取最新的表格数据以执行两步总结。');
            MarkChatAsWaiting(currentPiece, swipeUid);
            return;
        }
        const latestTables = BASE.hashSheetsToSheets(lastPiece.hash_sheets).filter(sheet => sheet.enable);
        const originText = '<表格内容>\n' + latestTables
            .map((table, index) => table.getTableText(index, ['title', 'node', 'headers', 'rows']))
            .join("\n");

        const oldTableStructure = sheetsToTables(latestTables);
        const tableHeadersOnly = oldTableStructure.map((table, index) => ({
            tableName: table.tableName || `Table ${index + 1}`,
            headers: table.columns || []
        }));
        const tableHeadersJson = JSON.stringify(tableHeadersOnly);
        
        const useMainApiForStepByStep = USER.tableBaseSetting.step_by_step_use_main_api === undefined ? true : USER.tableBaseSetting.step_by_step_use_main_api;

        const isSilentMode = confirmResult === 'dont_remind_active';

        // 调用增量更新函数，并传递 isStepByStepSummary 标志
        const r = await executeIncrementalUpdateFromSummary(
            todoChats,
            originText,
            tableHeadersJson,
            latestTables,
            useMainApiForStepByStep, // API choice for step-by-step
            USER.tableBaseSetting.bool_silent_refresh, // isSilentUpdate
            true, // isStepByStepSummary flag
            isSilentMode // Pass silent mode flag
        );

        console.log('执行分步总结（增量更新）结果:', r);
        if (r === 'success') {
            toBeExecuted.forEach(chat => {
                const chatSwipeUid = getSwipeUid(chat);
                chat.two_step_links[chatSwipeUid].push(swipeUid);   // 标记已执行的两步总结
            });
            toBeExecuted = [];

            reloadCurrentChat()
        } else if (r === 'suspended' || r === 'error' || !r) {
            console.log('执行增量两步总结失败或取消: ', `(${todoChats.length}) `, toBeExecuted);
            MarkChatAsWaiting(currentPiece, swipeUid);
        }
        // Removed old rebuild logic and result handling as it's now incremental
        // if (!r || r === '' || r === 'error') {
        //     console.log('执行两步总结失败: ', `(${todoChats.length}) `, toBeExecuted);
        //     MarkChatAsWaiting(currentPiece, swipeUid);
        // } else if (r === 'suspended') {
        //     console.log('用户取消执行两步总结 (API): ', `(${todoChats.length}) `, toBeExecuted);
        //     MarkChatAsWaiting(currentPiece, swipeUid);
        // } else {
        //     toBeExecuted.forEach(chat => {
        //         const chatSwipeUid = getSwipeUid(chat);
        //         chat.two_step_links[chatSwipeUid].push(swipeUid);   // 标记已执行的两步总结
        //     });
        //     toBeExecuted = [];
        // }
    }
}

/**
 * 手动触发分步填表。
 * 这是“立即填表”按钮的入口点，它通过使用 forceExecute=true 参数来调用核心的 TableTwoStepSummary 函数，
 * 从而确保手动触发的流程与自动触发的流程在逻辑上完全一致。
 */
export async function triggerStepByStepNow() {
    console.log('[Memory Enhancement] Manually triggering step-by-step update by calling TableTwoStepSummary(true)...');
    EDITOR.info("正在启动手动分步填表...");
    await TableTwoStepSummary(true);
}
