import { verifyBearer as ghstVerifyBearer } from "./verify-bearer";

export async function verifyBearer(
  request: Request,
  secret: string | undefined | null,
): Promise<boolean> {
  return ghstVerifyBearer(request.headers.get("Authorization"), secret ?? undefined);
}
