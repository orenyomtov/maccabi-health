import { MaccabiAuth, type LoginPhoneChoice } from "./auth";
import { MaccabiReaders } from "./readers";
import type { MaccabiSession } from "./session";
import { MaccabiTransport } from "./transport";

export type MaccabiClient = MaccabiReaders & {
  exportSession(): Promise<MaccabiSession>;
};

export interface SmsLogin {
  phones: LoginPhoneChoice[];
  sms(phoneIndex?: number): Promise<void>;
  verify(code: string): Promise<MaccabiClient>;
}

async function open(session: MaccabiSession): Promise<MaccabiClient> {
  const transport = new MaccabiTransport({ session });
  const readers = await MaccabiReaders.create(transport);
  return Object.assign(readers, { exportSession: () => transport.exportSession() });
}

/** Starts SMS login. Sends nothing until `sms()`. */
export async function login(idNumber: string): Promise<SmsLogin> {
  const auth = new MaccabiAuth();
  const challenge = await auth.beginLogin(idNumber);
  return {
    phones: challenge.phones,
    sms: (phoneIndex?: number) => auth.requestOtp(challenge.id, phoneIndex),
    verify: (code: string) => auth.completeLogin(challenge.id, code).then(open),
  };
}

/** Opens a session previously returned by `client.exportSession()`. */
export function connect(session: MaccabiSession): Promise<MaccabiClient> {
  return open(session);
}
