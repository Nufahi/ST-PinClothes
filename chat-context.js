export function wardrobeChat(context) {
    const chatId = context.chatId ?? context.getCurrentChatId?.();
    if (chatId == null || chatId === '') return null;
    if (context.groupId != null && context.groupId !== '') {
        const group = context.groups?.find(group => String(group.id) === String(context.groupId));
        return { key: JSON.stringify(['group', String(context.groupId), String(chatId)]), name: group?.name || 'Групповой чат' };
    }
    const character = context.characters?.[context.characterId];
    if (!character?.avatar) return null;
    return { key: JSON.stringify(['character', character.avatar, String(chatId)]), name: character.name || context.name2 || 'Текущий чат' };
}
