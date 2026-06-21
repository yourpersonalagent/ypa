export type WelcomeDay = {
  readonly id: string;
  readonly label: string;
  // 24 messages, indexed by local hour (0-23). {name} is replaced with the user's first name.
  readonly messages: readonly string[];
};
