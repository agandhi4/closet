import { IsEmail, IsString } from 'class-validator';
import { Match } from '../match.decorator';
import { IsAcceptablePassword } from '../password-rules.decorator';
import { i18nValidationMessage } from 'nestjs-i18n';
import { I18nTranslations } from '../../i18n/generated/i18n.generated';

export class RegisterDto {
  @IsString()
  @IsEmail(
    {},
    {
      message: i18nValidationMessage<I18nTranslations>(
        'lang.validation.IS_EMAIL',
      ),
    },
  )
  email: string;

  @IsAcceptablePassword()
  password: string;

  @Match('password', {
    message: i18nValidationMessage<I18nTranslations>(
      'lang.validation.PASSWORDS_MUST_MATCH',
    ),
  })
  confirmPassword: string;
}
