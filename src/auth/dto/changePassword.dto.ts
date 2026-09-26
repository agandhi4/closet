import { IsString } from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';
import { I18nTranslations } from '../../i18n/generated/i18n.generated';
import { Match } from '../match.decorator';
import { IsAcceptablePassword } from '../password-rules.decorator';

/** POST /auth/change-password. AuthService checks the current password. */
export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsAcceptablePassword()
  newPassword: string;

  @Match('newPassword', {
    message: i18nValidationMessage<I18nTranslations>(
      'lang.validation.PASSWORDS_MUST_MATCH',
    ),
  })
  confirmPassword: string;
}
