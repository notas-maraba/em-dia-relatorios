# Verificação

npm run check confere sintaxe. npm test executa regras de negócio e PDF, cliente de nuvem por grupo, ciclo de autenticação/troca de grupo/gravação da interface e função de administração de usuários com dependências simuladas e dados fictícios.

Os testes conferem sessão verificada, autorização, base vazia, falhas de rede, conflitos e ausência de repetição automática de gravação. A interface deve ocultar dados antes do login, confirmar alterações só após resposta do banco e limpar a tela ao sair.

tests/groups-security.sql simula papéis JWT dentro de uma transação com rollback no projeto dedicado. Verifica visitante, conta não autorizada, dois grupos, tentativa de autoautorização ou promoção, gestão exclusiva da administração, compatibilidade com a versão anterior, gravação direta negada e revisão obsoleta recusada. Nenhum registro fictício deve permanecer. tests/security.sql é a verificação histórica da estrutura da versão 2; para a versão 3 use o teste por grupos.

Antes de liberar, confira no navegador login, saída, recarga, abertura automática do checklist no grupo vinculado, seletor e gestão de grupos exclusivos da administração, administração de usuários, cadastro, relatórios, PDF, backup e dados preservados. A consulta de outro grupo pelo administrador deve permanecer durante a sessão; uma nova entrada deve abrir o grupo padrão. Confira tela pequena e segunda sessão. Testes de módulos não substituem essas verificações. Não altere dados reais apenas para testar nem publique evidências com nomes reais.

tests/pwa.test.cjs verifica escopo do manifesto e ícones, instalação somente após clique, instruções para iPhone, ocultação em modo instalado e cache limitado aos arquivos públicos. A confirmação real de instalação depende do navegador do aparelho. Confira também 320, 390 e 430 pixels, navegação administrativa com cinco abas e ausência de rolagem horizontal da página; as tabelas e filtros podem rolar dentro do próprio quadro.
