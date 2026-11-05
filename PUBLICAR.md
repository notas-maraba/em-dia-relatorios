# Publicação e configuração

Publique somente o código desta pasta, com index.html, assets/ e .nojekyll na raiz. Use GitHub Pages, main, / (root). Confira a implantação e o site antes de informar sucesso.

Nunca envie backups, HTML pessoal, relatórios, capturas com dados reais ou arquivos da transferência ao GitHub. Revise a lista manualmente; .gitignore não protege uploads pelo navegador.

## Supabase

1. Use projeto dedicado e confirme o plano.
2. Em uma instalação nova, revise e aplique supabase/schema.sql uma única vez. Em seguida aplique supabase/groups-upgrade.sql. Em uma instalação existente da versão 2, aplique apenas o upgrade, após guardar uma cópia privada atualizada. Mantenha em_dia_private fora dos schemas expostos na Data API. O upgrade conserva a base e cria seus vínculos de grupo; não reimporte uma base antiga por cima de alterações novas.
3. Após o upgrade por grupos, aplique as migrações de supabase/migrations/ em ordem, uma única vez. A migração de perfis converte os administradores existentes em admin e os demais responsáveis em superintendent, sem substituir suas bases ou vínculos. Guarde uma cópia privada atualizada antes de aplicar. Não execute novamente os scripts históricos sobre uma instalação atualizada.
4. A primeira conta administradora precisa ser provisionada por administração confiável no Supabase Auth/em_dia_members. Não publique identidade nem credenciais no SQL. As demais contas de administrador/superintendente são cadastradas em Usuários. Acesso de publicador é criado em Publicadores → Editar para um cartão existente. Os campos is_admin/access_role e os vínculos só podem ser alterados pelas operações autorizadas, nunca diretamente pelo cliente.
5. Desative cadastro público e login anônimo. Mantenha e-mail/senha habilitado. Configure Site URL para o endereço exato do site. Links por e-mail dependem do SMTP: o serviço padrão limita destinatários à equipe.
6. assets/config.js recebe apenas URL, chave publishable e retorno. Nunca chaves de administração.
7. Implante a Edge Function em-dia-users com verificação de JWT habilitada e também verificação de usuário/perfil no próprio servidor. Use as variáveis protegidas fornecidas pelo Supabase; nunca copie chaves secretas para o navegador ou repositório. Atualize o banco e a função antes de publicar a interface.
8. Teste o isolamento de cada perfil, reenvios, decisões e transferências usando testes SQL com transação e rollback. Não use cartões reais para testar nem reimporte dados antigos sobre a base atual. Confira os consultores de segurança e as permissões das funções após a migração.

Faça login, selecione o grupo e use Dados → Importar backup. Exporte uma cópia antes de substituir uma base existente. A importação grava apenas no grupo selecionado, fora do GitHub. Recarregue e confira os registros.

Em atualizações, preserve a base e as contas. Não reaplique a criação do schema; use migrações revisadas.

Na atualização do diário de horas, a migração deve preceder a interface. Ela cria armazenamento privado e funções autorizadas, sem inventar lançamentos para totais antigos nem substituir os relatórios recebidos. Verifique os testes de isolamento, datas, controle de versão, envio de mês encerrado e transferência com diário. Guarde uma cópia privada das tabelas atuais, incluindo vínculos e revisões. As cópias futuras do banco devem incluir também os diários, que não fazem parte do backup JSON do grupo. Não altere dados reais para testar.

Na atualização para vários lançamentos por dia, guarde uma cópia privada atualizada incluindo o diário antes de aplicar a migração. A migração representa cada dia existente por um único lançamento, preservando os totais, versões e datas de atualização. Aplique a estrutura antes da interface e confira o teste transacional de múltiplos lançamentos. Uma versão antiga pode consultar o total do dia, mas precisa ser atualizada para modificar um dia que contenha vários registros separados.

## Instalação no celular

Publique também manifest.webmanifest, sw.js, assets/install.js e assets/icons/. A instalação usa HTTPS no endereço público e abre em janela de aplicativo. Não precisa de uma loja de aplicativos.

Em cada nova versão, atualize RELEASE em sw.js, os arquivos públicos da lista SHELL e as versões dos assets em index.html. Não reutilize a versão do cache após mudar arquivos. O worker novo aguarda as abas antigas fecharem, para não interromper formulários abertos. Não adicione respostas do Supabase, callbacks de login, backups ou outros dados pessoais ao cache.
