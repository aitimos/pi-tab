const messages={
  BINDING_CONFLICT:'另一窗口已切换执行页面，请刷新状态后重试。',
  CONTINUE_HERE_REQUIRED:'页面状态已变化，本次未发送，请重试。',
  CONVERSATION_BUSY:'任务正在运行，请先停止或等待任务完成后再切换。',
  CONVERSATION_STOPPING:'正在停止任务，请稍后重试。',
  CONVERSATION_NOT_DRAINED:'任务尚未完全停止，请等待后重试。',
  TARGET_INVALIDATED:'页面已变化，请查看历史和队列后再发送。',
  TARGET_PERMISSION_OR_UNSUPPORTED:'目标页面无法访问，请在支持的普通网页重试。',
  OWNER_RECOVERY_REQUIRED:'来源站点有中断任务，可从对话菜单停止中断任务后再发送。',
  RECOVERY_VERSION_CHANGED:'恢复状态已变化，请刷新状态后重试。',
  RECOVERY_NOT_PAUSED:'恢复任务未处于暂停状态，请重新打开扩展后重试。',
  RECOVERY_NOT_DRAINED:'来源任务尚未清理完成，请重试恢复操作。',
  PICKER_UNAUTHORIZED:'历史选择已失效，请关闭后重新打开。',
  PICKER_EXPIRED:'历史选择已失效，请关闭后重新打开。',
  CONVERSATION_NOT_SELECTED:'请通过“历史对话”选择原对话。',
  CONVERSATION_DELETED:'这条对话已删除，请选择其他对话。',
  SOURCE_DELETED_INDEX_DIRTY:'对话已删除，请刷新目录以更新列表。',
  RECONNECT_REVIEW_HISTORY:'连接已重建，请先查看历史和队列，再确认是否重新发送。',
  DOCUMENT_RECONNECT_REQUIRED:'连接已重建，请先查看历史和队列，再确认是否重新发送。',
  HISTORY_INDEX_VERSION:'历史目录版本不受支持，可继续使用本站对话。',
};
export function continuationErrorMessage(error){return messages[error.message]||error.message||String(error);}
export const continuationErrorMessages=messages;
