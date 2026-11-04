# Publicação e configuração

Publique somente o código desta pasta, com index.html, assets/ e .nojekyll na raiz. Use GitHub Pages, main, / (root). Confira a implantação e o site antes de informar sucesso.

Nunca envie backups, HTML pessoal, relatórios, capturas com dados reais ou arquivos da transferência ao GitHub. Revise a lista manualmente; .gitignore não protege uploads pelo navegador.

## Supabase

1. Use projeto dedicado e confirme o plano.
2. Em uma instalação nova, revise e aplique supabase/schema.sql uma única vez. Em seguida aplique supabase/groups-upgrade.sql. Em uma instalação existente da versão 2, aplique apenas o upgrade, após guardar uma cópia privada atualizada. Mantenha em_dia_private fora dos schemas expostos na Data API. O upgrade conserva a base e cria seus vínculos de grupo; não reimporte uma base antiga por cima de alterações novas.
3. A primeira conta administradora precisa ser provisionada por administração confiável no Supabase Auth/em_dia_members. Não publique identidade nem credenciais no SQL do repositório. As contas seguintes são cadastradas na aba Usuários, vinculadas a um grupo existente ou novo. O campo is_admin só pode ser alterado pela administração confiável, nunca pelo cliente.
4. Desative cadastro público e login anônimo. Mantenha e-mail/senha habilitado. Configure Site URL para o endereço exato do site. Links por e-mail dependem do SMTP: o serviço padrão limita destinatários à equipe.
5. assets/config.js recebe apenas URL, chave publishable e retorno. Nunca chaves de administração.
6. Implante a Edge Function em-dia-users com verificação de JWT habilitada e também verificação de usuário/administrador no próprio servidor. Use as variáveis protegidas fornecidas pelo Supabase; nunca copie chaves secretas para o navegador ou repositório. Faça a implantação do banco e função antes de publicar a interface por grupos.
7. Teste as regras, isolamento entre grupos e concorrência antes de importar dados privados. tests/groups-security.sql executa as verificações dentro de transação com rollback.

Faça login, selecione o grupo e use Dados → Importar backup. Exporte uma cópia antes de substituir uma base existente. A importação grava apenas no grupo selecionado, fora do GitHub. Recarregue e confira os registros.

Em atualizações, preserve a base e as contas. Não reaplique a criação do schema; use migrações revisadas.

## Instalação no celular

Publique também manifest.webmanifest, sw.js, assets/install.js e assets/icons/. A instalação usa HTTPS no endereço público e abre em janela de aplicativo. Não precisa de uma loja de aplicativos.

Em cada nova versão, atualize RELEASE em sw.js, os arquivos públicos da lista SHELL e as versões dos assets em index.html. Não reutilize a versão do cache após mudar arquivos. O worker novo aguarda as abas antigas fecharem, para não interromper formulários abertos. Não adicione respostas do Supabase, callbacks de login, backups ou outros dados pessoais ao cache.
