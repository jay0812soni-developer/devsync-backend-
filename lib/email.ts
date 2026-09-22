import nodemailer from 'nodemailer';

// Configure SMTP transport with Gmail credentials or fallback environment variables
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const fromEmail = process.env.FROM_EMAIL || `"DevSync" <${smtpUser}>`;

const transporter = nodemailer.createTransport(
  smtpHost === 'smtp.gmail.com'
    ? {
        service: 'gmail',
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      }
    : {
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      }
);

/**
 * Builds our signature dark-mode DevSync email template
 */
export function buildDevSyncEmailHtml(otp: string, recipientName: string = 'Developer'): string {
  const digits = otp.split('');
  const digitBoxes = digits
    .map(
      (d) => `
      <td align="center" style="padding: 0 4px;">
        <div style="background-color: #2E2A24; border: 1px solid #3E382F; border-radius: 6px; width: 44px; height: 54px; line-height: 54px; text-align: center; color: #F3EDE4; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 26px; font-weight: 600;">
          ${d}
        </div>
      </td>`
    )
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevSync Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #1B1916; font-family: 'Segoe UI', Helvetica, Arial, sans-serif; color: #F3EDE4;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #1B1916; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="560" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #24211C; border-radius: 8px; border: 1px solid #3E382F; overflow: hidden;">
          <tr>
            <td style="background-color: #C4622D; height: 3px;"></td>
          </tr>

          <!-- Header / Brand Logo -->
          <tr>
            <td align="center" style="padding: 36px 30px 10px 30px;">
              <div style="font-size: 18px; font-weight: 600; color: #F3EDE4; letter-spacing: -0.3px;">DevSync</div>
              <h1 style="color: #F3EDE4; font-size: 20px; font-weight: 600; margin: 18px 0 6px 0;">
                Verification code
              </h1>
              <p style="color: #B7AA9A; font-size: 14px; margin: 0; line-height: 1.5;">
                Enter this code on the device you are registering.
              </p>
            </td>
          </tr>

          <!-- 6-Digit OTP Block -->
          <tr>
            <td align="center" style="padding: 30px 20px;">
              <table border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  ${digitBoxes}
                </tr>
              </table>
              <p style="color: #8A7E70; font-size: 12px; margin-top: 20px;">
                This code expires in 15 minutes. Do not share it.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding: 0 30px;">
              <div style="border-top: 1px solid #3E382F;"></div>
            </td>
          </tr>

          <!-- Security Notice & Tips -->
          <tr>
            <td style="padding: 24px 30px 30px 30px;">
              <p style="color: #B7AA9A; font-size: 12px; margin: 0; line-height: 1.6;">
                After this, the first device shows a 6-digit connection code. Enter that code on each other device.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background-color: #1B1916; padding: 20px; border-top: 1px solid #3E382F;">
              <p style="color: #8A7E70; font-size: 11px; margin: 0;">
                DevSync
              </p>
              <p style="color: #484F58; font-size: 11px; margin: 4px 0 0 0;">
                If you did not request this verification, you can safely ignore this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Sends the 6-digit OTP email using Nodemailer
 */
export async function sendOtpEmail(recipientEmail: string, otp: string, recipientName: string = 'Developer'): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (!smtpUser || !smtpPass) {
      return { success: false, error: 'SMTP_USER and SMTP_PASS are not set' };
    }

    const htmlContent = buildDevSyncEmailHtml(otp, recipientName);

    const info = await transporter.sendMail({
      from: fromEmail,
      to: recipientEmail,
      subject: `DevSync Verification Code: ${otp}`,
      text: `Your DevSync 6-digit verification code is: ${otp}. It expires in 15 minutes.\n\nIf you did not request this verification, you can safely ignore this email.`,
      html: htmlContent,
      priority: 'high',
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        'Importance': 'high',
      },
    });

    console.log(`[Email] OTP email sent successfully to ${recipientEmail}, messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error(`[Email] Failed to send OTP email via SMTP:`, err.message);
    // If SMTP fails (e.g. rate limit / network block), return failure with error
    return { success: false, error: err.message };
  }
}
