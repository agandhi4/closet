import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MinLength } from 'class-validator';
import { i18nValidationMessage } from 'nestjs-i18n';
import { I18nTranslations } from '../i18n/generated/i18n.generated';

/**
 * The rules every new password must meet: registration (RegisterDto) and
 * the change-password form (ChangePasswordDto).
 */
export function IsAcceptablePassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(8, {
      message: i18nValidationMessage<I18nTranslations>(
        'lang.validation.MIN_PASSWORD_LENGTH',
      ),
    }),
    Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
      message: i18nValidationMessage<I18nTranslations>(
        'lang.validation.PASSWORD_MUST_CONTAIN',
      ),
    }),
  );
}
