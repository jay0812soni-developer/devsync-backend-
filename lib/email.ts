import nodemailer from 'nodemailer';

// Configure SMTP transport with Gmail credentials or fallback environment variables
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
const smtpUser = process.env.SMTP_USER || 'sonijay1908@gmail.com';
const smtpPass = (process.env.SMTP_PASS || 'lgey stsr ywii vnjv').replace(/\s+/g, '');
const fromEmail = process.env.FROM_EMAIL || `"DevSync" <${smtpUser}>`;

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465, // true for 465, false for 587
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

/**
 * Builds our signature dark-mode DevSync email template
 */
export function buildDevSyncEmailHtml(otp: string, recipientName: string = 'Developer'): string {
  const digits = otp.split('');
  const digitBoxes = digits
    .map(
      (d) => `
      <td align="center" style="padding: 0 4px;">
        <div style="background-color: #161B22; border: 2px solid #00F5D4; border-radius: 8px; width: 44px; height: 54px; line-height: 54px; text-align: center; color: #FFFFFF; font-family: 'Courier New', Courier, monospace; font-size: 28px; font-weight: 700; box-shadow: 0 0 12px rgba(0, 245, 212, 0.3);">
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
<body style="margin: 0; padding: 0; background-color: #080B10; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #E6EDF3;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #080B10; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="560" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #0D1117; border-radius: 16px; border: 1px solid #21262D; overflow: hidden; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8);">
          
          <!-- Top Neon Glowing Header -->
          <tr>
            <td style="background: linear-gradient(90deg, #00F5D4 0%, #7B2CBF 100%); height: 4px;"></td>
          </tr>

          <!-- Header / Brand Logo -->
          <tr>
            <td align="center" style="padding: 36px 30px 10px 30px;">
              <div style="display: inline-block; background: #161B22; border-radius: 12px; padding: 10px 18px; border: 1px solid #30363D;">
                <span style="color: #00F5D4; font-family: 'Courier New', monospace; font-weight: 800; font-size: 20px; letter-spacing: 2px;">DEV</span>
                <span style="color: #FFFFFF; font-family: 'Courier New', monospace; font-weight: 800; font-size: 20px; letter-spacing: 2px;">SYNC</span>
              </div>
              <h1 style="color: #FFFFFF; font-size: 22px; font-weight: 700; margin: 20px 0 6px 0; letter-spacing: -0.5px;">
                Verify Your Account
              </h1>
              <p style="color: #8B949E; font-size: 14px; margin: 0; line-height: 1.5;">
                Welcome, ${recipientName}! Use this code to complete authentication and start syncing your devices worldwide.
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
              <p style="color: #8B949E; font-size: 12px; margin-top: 20px;">
                This code expires in <strong style="color: #00F5D4;">10 minutes</strong>. Never share this code with anyone.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding: 0 30px;">
              <div style="border-top: 1px solid #21262D;"></div>
            </td>
          </tr>

          <!-- Security Notice & Tips -->
          <tr>
            <td style="padding: 24px 30px 30px 30px;">
              <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #161B22; border-radius: 8px; border-left: 3px solid #7B2CBF; padding: 12px 16px;">
                <tr>
                  <td>
                    <p style="color: #C9D1D9; font-size: 12px; margin: 0; line-height: 1.6;">
                      <strong>Security Tip:</strong> Once verified, your first device will generate a 6-digit <strong>Connection Code</strong>. Use it to pair your laptops, tablets, and phones seamlessly worldwide with zero cloud storage retention.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background-color: #090D13; padding: 20px; border-top: 1px solid #161B22;">
              <p style="color: #484F58; font-size: 11px; margin: 0;">
                © ${new Date().getFullYear()} DevSync • Sovereign Multi-Device Developer Mesh
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
    const htmlContent = buildDevSyncEmailHtml(otp, recipientName);

    const info = await transporter.sendMail({
      from: fromEmail,
      to: recipientEmail,
      subject: `Your DevSync Verification Code: ${otp}`,
      text: `Your DevSync 6-digit verification code is: ${otp}. It expires in 10 minutes.`,
      html: htmlContent,
    });

    console.log(`[Email] OTP email sent successfully to ${recipientEmail}, messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error(`[Email] Failed to send OTP email via SMTP:`, err.message);
    // If SMTP fails (e.g. rate limit / network block), return failure with error
    return { success: false, error: err.message };
  }
}
