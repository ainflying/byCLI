import { ArgumentError } from '@sovovs/bycli/errors';

// This is an explicit attestation by the caller, not proof of a conversation.
// Upper-level agents must show the saved draft and obtain user confirmation
// for that exact content before setting this flag on the separate submit call.
export const USER_CONFIRMED_ARG = { name: 'user-confirmed', type: 'boolean',
  help: '仅 submit：上层 Agent 已展示并获得用户对当前已核对草稿的明确发布确认；准备阶段不得预先设置' };

export function requirePublishConfirmation(args) {
  if (args.mode === 'submit' && args['user-confirmed'] !== true) {
    throw new ArgumentError('Save and verify the platform draft, present it to the user, then submit separately with --user-confirmed after explicit confirmation');
  }
  if (args.mode !== 'submit' && args['user-confirmed'] !== undefined) {
    throw new ArgumentError('--user-confirmed is only valid for a separate submit after draft review');
  }
}
