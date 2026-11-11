interface SyntheticSession {
  synthetic(input: {
    sessionID: string;
    text: string;
    description: string;
    resume: false;
  }): Promise<unknown>;
}

export function sessionNotification(session: SyntheticSession) {
  return async (sessionID: string, text: string): Promise<void> => {
    await session.synthetic({
      sessionID,
      text,
      description: 'Beads Observer browser URL',
      resume: false,
    });
  };
}
