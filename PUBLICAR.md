# Publicação e configuração

Publique somente o código desta pasta, com index.html, assets/ e .nojekyll na raiz. Use GitHub Pages, main, / (root). Confira a implantação e o site antes de informar sucesso.

Nunca envie backups, HTML pessoal, relatórios, capturas com dados reais ou arquivos da transferência ao GitHub. Revise a lista manualmente; .gitignore não protege uploads pelo navegador.

## Supabase

1. Use projeto dedicado e confirme o plano.
2. Revise e aplique supabase/schema.sql uma única vez por administração confiável. Mantenha em_dia_private fora dos schemas expostos na Data API.
3. Crie o responsável pelo Supabase Auth e autorize seu ID em em_dia_members. Não publique identidade nem credenciais no SQL do repositório.
4. Desative cadastro público e login anônimo. Mantenha e-mail/senha habilitado. Configure Site URL para o endereço exato do site. Links por e-mail dependem do SMTP: o serviço padrão limita destinatários à equipe.
5. assets/config.js recebe apenas URL, chave publishable e retorno. Nunca chaves de administração.
6. Teste as regras e concorrência antes de importar dados privados.

Faça login e use Dados → Importar backup. Exporte uma cópia antes de substituir uma base existente. A importação grava no banco da conta, fora do GitHub. Recarregue e confira os registros.

Em atualizações, preserve a base e as contas. Não reaplique a criação do schema; use migrações revisadas.
